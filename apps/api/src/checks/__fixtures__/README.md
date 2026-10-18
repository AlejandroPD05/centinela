# Fixtures de TLS

Certificado y clave autofirmados **solo para tests** (jamás usarlos fuera de
ellos). Se generaron dentro del contenedor de PostgreSQL, que trae OpenSSL:

```sh
openssl req -x509 -newkey rsa:2048 -keyout tls-key.pem -out tls-cert.pem \
  -days 3650 -nodes -subj "/CN=centinela-test"
```

Valen 10 años y llevan CN `centinela-test`: lo justo para comprobar que el
sondeo TLS lee caducidad y emisor de un certificado real servido en local.
