FROM python:3.12-slim

WORKDIR /app

COPY . /app

EXPOSE 5500
EXPOSE 5443

CMD ["python", "portal_server.py"]
