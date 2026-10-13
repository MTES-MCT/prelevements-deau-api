#!/usr/bin/env python3
"""Read the access ODS without modifying it or extracting archive members."""

import hashlib
import io
import json
from datetime import date, datetime
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile


MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_CONTENT_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_ROWS = 10000
MAX_COLUMNS = 64
MAX_TEXT_LENGTH = 65536
MAX_OUTPUT_TEXT = 2 * 1024 * 1024
MAX_POPULATED_CELLS = 100000
NS = {
    key: f"urn:oasis:names:tc:opendocument:xmlns:{name}:1.0"
    for key, name in (("office", "office"), ("table", "table"), ("text", "text"))
}


def attr(element, namespace, name, default=None):
    return element.get(f"{{{NS[namespace]}}}{name}", default)


def repeated(element, name):
    count = int(attr(element, "table", name, "1"))
    if not 1 <= count <= 1048576:
        raise ValueError("Répétition ODS invalide")
    return count


def paragraph_text(element):
    chunks = [element.text or ""]
    for child in element:
        if child.tag == f"{{{NS['text']}}}s":
            count = int(attr(child, "text", "c", "1"))
            if not 1 <= count <= MAX_TEXT_LENGTH:
                raise ValueError("Espacement ODS excessif")
            chunks.append(" " * count)
        elif child.tag == f"{{{NS['text']}}}tab":
            chunks.append("\t")
        elif child.tag == f"{{{NS['text']}}}line-break":
            chunks.append("\n")
        else:
            chunks.append(paragraph_text(child))
        chunks.append(child.tail or "")
    text = "".join(chunks)
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError("Texte ODS excessif")
    return text


def cell_text(cell):
    if attr(cell, "office", "value-type") == "date":
        value = attr(cell, "office", "date-value")
        if value is None:
            raise ValueError("Date ODS sans valeur")
        # Spreadsheet dates express a local calendar day, not an instant to shift.
        return datetime.fromisoformat(value).date().isoformat() if "T" in value else date.fromisoformat(value).isoformat()
    paragraphs = cell.findall("text:p", NS)
    if paragraphs:
        return "\n".join(paragraph_text(p) for p in paragraphs)
    return attr(cell, "office", "string-value", "")


def sheet_rows(sheet, output_budget):
    result = []
    row_number = 1
    for row in sheet.findall(".//table:table-row", NS):
        cells = []
        column = 0
        row_repeats = repeated(row, "number-rows-repeated")
        for cell in row:
            if cell.tag not in (
                f"{{{NS['table']}}}table-cell",
                f"{{{NS['table']}}}covered-table-cell",
            ):
                continue
            count = repeated(cell, "number-columns-repeated")
            value = cell_text(cell)
            if value and column + count > MAX_COLUMNS:
                raise ValueError("Trop de colonnes ODS renseignées")
            if column < MAX_COLUMNS:
                cells.extend([value] * min(count, MAX_COLUMNS - column))
            column += count
        while cells and not cells[-1]:
            cells.pop()
        if cells:
            if row_number + row_repeats - 1 > MAX_ROWS:
                raise ValueError("Trop de lignes ODS renseignées")
            output_budget["text"] += sum(len(value) for value in cells) * row_repeats
            output_budget["cells"] += len(cells) * row_repeats
            if output_budget["text"] > MAX_OUTPUT_TEXT or output_budget["cells"] > MAX_POPULATED_CELLS:
                raise ValueError("Contenu ODS répété trop volumineux")
            for offset in range(row_repeats):
                result.append({"row": row_number + offset, "cells": cells})
        row_number += row_repeats
    return result


def extract(filename):
    path = Path(filename)
    with path.open("rb") as source:
        data = source.read(MAX_ARCHIVE_BYTES + 1)
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Classeur ODS trop volumineux")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) > 256 or len({m.filename for m in members}) != len(members):
            raise ValueError("Structure ZIP ODS invalide")
        if sum(m.file_size for m in members) > MAX_TOTAL_BYTES:
            raise ValueError("Archive ODS décompressée trop volumineuse")
        if any(m.flag_bits & 1 for m in members):
            raise ValueError("Classeur ODS chiffré non pris en charge")
        if archive.getinfo("mimetype").file_size > 128:
            raise ValueError("Type ODS invalide")
        if archive.read("mimetype") != b"application/vnd.oasis.opendocument.spreadsheet":
            raise ValueError("Le fichier doit être un classeur ODS")
        content_info = archive.getinfo("content.xml")
        if content_info.file_size > MAX_CONTENT_BYTES:
            raise ValueError("Contenu ODS trop volumineux")
        content = archive.read(content_info)
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise ValueError("Déclarations XML interdites")
    root = ET.fromstring(content)
    sheets = root.findall("office:body/office:spreadsheet/table:table", NS)
    if not 1 <= len(sheets) <= 16:
        raise ValueError("Nombre de feuilles ODS invalide")
    names = [attr(sheet, "table", "name") for sheet in sheets]
    if any(not name for name in names) or len(set(names)) != len(names):
        raise ValueError("Noms de feuilles ODS invalides")
    output_budget = {"text": 0, "cells": 0}
    return {
        "version": 1,
        "source": {"sha256": hashlib.sha256(data).hexdigest(), "name": path.name},
        "sheets": [{"name": name, "rows": sheet_rows(sheet, output_budget)} for name, sheet in zip(names, sheets)],
    }


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Un chemin ODS est requis")
        print(json.dumps(extract(sys.argv[1]), ensure_ascii=False))
    except (ValueError, OSError, KeyError, ET.ParseError, zipfile.BadZipFile) as error:
        # Never print source contents or credentials from a supplied filename.
        print(f"Extraction ODS impossible ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
