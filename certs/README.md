# T-Bank TLS trust anchor

`russian_trusted_root_ca_pem.crt` is the RSA Russian Trusted Root CA used by
the T-Bank Invest API endpoint. It is a public certificate downloaded from the
official Gosuslugi certificate page: <https://www.gosuslugi.ru/crt>.

SHA-256 fingerprint:

`D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`

The container loads this additional trust anchor through `NODE_EXTRA_CA_CERTS`.
TLS verification must remain enabled.
