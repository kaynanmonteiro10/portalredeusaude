import io, json, time
import portal_server as ps

TOKEN = "4a6c20cee63d6b24fc265c2c139812587f39f60f61a21250aeb10751bd43b745"
corpo = json.dumps({"dia": "03/11/2026"}).encode()


class Falso:
    def __init__(self):
        self.path = "/api/adesoes/conferir"
        self.command = "POST"
        self.headers = {"Authorization": f"Bearer {TOKEN}", "Content-Length": str(len(corpo))}
        self.rfile = io.BytesIO(corpo)
        self.wfile = io.BytesIO()
        self.saida = None

    def send_json(self, dados, codigo=200):
        self.saida = (codigo, dados)

    def send_response(self, *a, **k):
        pass

    def send_header(self, *a, **k):
        pass

    def end_headers(self):
        pass


inicio = time.time()
f = Falso()
ps.PortalHandler.do_POST(f)
print("tempo:", round(time.time() - inicio, 2), "s")
print("resposta:", json.dumps(f.saida, ensure_ascii=False)[:400])
