"""Gera a autoridade certificadora (CA) do portal e o certificado do site.

Rode com o portal parado:

    python gerar_certificado.py

Arquivos gerados:

    portal-ca.pem      certificado da CA (público; vai dentro do Preparar-Portal.bat)
    portal-ca-key.pem  chave da CA (fica só neste computador)
    portal-cert.pem    certificado do site + CA (usado pelo portal)
    portal-key.pem     chave do site (fica só neste computador)

O certificado do site precisa ser assinado por uma CA e não pode ser ele
mesmo uma CA: o Firefox recusa certificados "CA usado como site"
(MOZILLA_PKIX_ERROR_CA_CERT_USED_AS_END_ENTITY).
"""
import datetime
import ipaddress
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

RAIZ = Path(__file__).resolve().parent
CERT = RAIZ / "portal-cert.pem"
CHAVE = RAIZ / "portal-key.pem"
CA_CERT = RAIZ / "portal-ca.pem"
CA_KEY = RAIZ / "portal-ca-key.pem"
NOME_CA = "Portal do Setor - Rede Saude"


def ips_locais():
    encontrados = {"127.0.0.1"}
    sonda = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sonda.connect(("8.8.8.8", 80))
        encontrados.add(sonda.getsockname()[0])
    except OSError:
        pass
    finally:
        sonda.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            encontrados.add(info[4][0])
    except OSError:
        pass
    return sorted(encontrados)


def gerar_ca(agora):
    chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, NOME_CA),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Rede Saude"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "Portal do Setor"),
    ])
    certificado = (
        x509.CertificateBuilder()
        .subject_name(nome)
        .issuer_name(nome)
        .public_key(chave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(agora - datetime.timedelta(days=1))
        .not_valid_after(agora + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(chave.public_key()), critical=False)
        .sign(chave, hashes.SHA256())
    )
    return certificado, chave


def gerar_site(agora, host, san, ca_cert, ca_chave):
    chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, host),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Rede Saude"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "Portal do Setor"),
    ])
    certificado = (
        x509.CertificateBuilder()
        .subject_name(nome)
        .issuer_name(ca_cert.subject)
        .public_key(chave.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(agora - datetime.timedelta(days=1))
        .not_valid_after(agora + datetime.timedelta(days=825))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_cert.public_key()), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(chave.public_key()), critical=False)
        .sign(ca_chave, hashes.SHA256())
    )
    return certificado, chave


def pem(certificado):
    return certificado.public_bytes(serialization.Encoding.PEM)


def main():
    host = socket.gethostname().split(".")[0].upper()
    ips = ips_locais()
    nomes = {"localhost", host.lower(), host}
    san = [x509.DNSName(nome) for nome in sorted(nomes)]
    san += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    agora = datetime.datetime.now(datetime.timezone.utc)

    ca_cert, ca_chave = gerar_ca(agora)
    site_cert, site_chave = gerar_site(agora, host, san, ca_cert, ca_chave)

    for arquivo in (CERT, CHAVE, CA_CERT, CA_KEY):
        if arquivo.exists():
            arquivo.replace(arquivo.with_suffix(".pem.bak"))

    CA_CERT.write_bytes(pem(ca_cert))
    CA_KEY.write_bytes(
        ca_chave.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    CERT.write_bytes(pem(site_cert) + pem(ca_cert))
    CHAVE.write_bytes(
        site_chave.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )

    print("CA e certificado do site gerados.")
    print(f"  CA: {NOME_CA}")
    print(f"  Validade da CA: ate {ca_cert.not_valid_after_utc.date()}")
    print(f"  Site: {host}")
    for valor in san:
        print(f"  - {valor.value}")
    print(f"  Validade do site: ate {site_cert.not_valid_after_utc.date()}")
    print()
    print("1) Reinicie o portal para carregar o novo certificado.")
    print("2) Atualize o bloco do certificado dentro do Preparar-Portal.bat com o")
    print("   conteudo de portal-ca.pem.")
    print("3) Em cada notebook, rode o Preparar-Portal.bat uma vez.")
    print("4) Abra https://%s:5443 e confirme que aparece o cadeado." % (ips[-1] if ips else "127.0.0.1"))
    print()
    print("portal-ca-key.pem e portal-key.pem ficam só neste computador.")


if __name__ == "__main__":
    main()
