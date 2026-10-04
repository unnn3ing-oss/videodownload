#!/usr/bin/env bash
# Prints a fresh base64 DER public key for extension/manifest.json's "key" field.
# The private key is generated in a pipe and never stored: it is not needed for an
# unpacked extension, and the key's only job is to pin a stable extension ID.
set -euo pipefail
openssl genrsa 2048 2>/dev/null | openssl rsa -pubout -outform DER 2>/dev/null | base64 | tr -d '\n'
echo
