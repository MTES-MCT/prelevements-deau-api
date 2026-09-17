"""Extract the explicitly approved referential attachments without logging their contents."""
import argparse
import email
import email.policy
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("mail", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
allowed = {"ExportTableEpiDropt.xlsx", "ExportEpiDropt.json", "ExportCompteursEpiDropt.docx"}
message = email.message_from_bytes(args.mail.read_bytes(), policy=email.policy.default)
args.destination.mkdir(mode=0o700, parents=True, exist_ok=True)
count = 0
for part in message.walk():
    name = part.get_filename()
    if name not in allowed:
        continue
    content = part.get_payload(decode=True)
    target = args.destination / name
    if target.exists():
        if target.read_bytes() != content:
            raise SystemExit("Refus de remplacer une pièce jointe différente.")
    else:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(content)
    count += 1
if count != len(allowed):
    raise SystemExit("Pièces jointes attendues absentes ou dupliquées.")
print(f"{count} pièces jointes extraites ; contenu et secrets non affichés.")
