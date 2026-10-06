from datetime import datetime, timedelta, timezone
from ipaddress import IPv4Address
from pathlib import Path
import socket

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parent
key_path = ROOT / "portal-key.pem"
cert_path = ROOT / "portal-cert.pem"
hostname = socket.gethostname()
ip = socket.gethostbyname(hostname)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
certificate = (
    x509.CertificateBuilder()
    .subject_name(subject)
    .issuer_name(issuer)
    .public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=1))
    .not_valid_after(datetime.now(timezone.utc) + timedelta(days=825))
    .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname), x509.IPAddress(IPv4Address(ip))]), critical=False)
    .sign(key, hashes.SHA256())
)
key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
print(f"Certificado criado para https://{ip}:5443")