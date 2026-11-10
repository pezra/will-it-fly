"""Append sites to sites.json in its hand formatting, so the rest of the file doesn't churn.

Usage: python3 -I append_sites.py <sites.json> <new_sites.json>

new_sites.json is a JSON list of site objects, with keys in the order they should appear. It
refuses a site or launch id that's already in the file, and sets curatedOn to today. Whole
numbers written as floats (45.0) come out as integers.
"""

from __future__ import annotations

import datetime
import json
import re
import sys

TAIL = "\n  ]\n}\n"
# Other objects are written on one line as { "a": 1 }. soaring and xc keep their existing
# {"notes": ...} spelling.
UNPADDED = {"soaring", "xc"}


def number(x):
    return int(x) if isinstance(x, float) and x.is_integer() else x


def value(x) -> str:
    if isinstance(x, float):
        x = number(x)
    if isinstance(x, dict):
        return "{ " + ", ".join(f"{json.dumps(k)}: {value(v)}" for k, v in x.items()) + " }" if x else "{}"
    if isinstance(x, list):
        return "[ " + ", ".join(value(v) for v in x) + " ]" if x else "[]"
    return json.dumps(x, ensure_ascii=False)


def unpadded(x: dict) -> str:
    return "{" + ", ".join(f"{json.dumps(k)}: {value(v)}" for k, v in x.items()) + "}"


def fields(obj: dict, indent: int, expand: dict) -> str:
    pad = " " * indent
    lines = []
    for k, v in obj.items():
        if k in expand:
            lines.append(f"{pad}{json.dumps(k)}: {expand[k](v, indent)}")
        elif k in UNPADDED and isinstance(v, dict):
            lines.append(f"{pad}{json.dumps(k)}: {unpadded(v)}")
        else:
            lines.append(f"{pad}{json.dumps(k)}: {value(v)}")
    return ",\n".join(lines)


def directions(d: dict, indent: int) -> str:
    return "{\n" + fields(d, indent + 2, {}) + "\n" + " " * indent + "}"


def launches(ls: list, indent: int) -> str:
    pad = " " * (indent + 2)
    body = ",\n".join(f"{pad}{{\n{fields(l, indent + 4, {'directions': directions})}\n{pad}}}" for l in ls)
    return "[\n" + body + "\n" + " " * indent + "]"


def site(s: dict) -> str:
    return "    {\n" + fields(s, 6, {"launches": launches}) + "\n    }"


def main() -> None:
    path, new_path = sys.argv[1], sys.argv[2]
    text = open(path).read()
    if not text.endswith(TAIL):
        sys.exit(f"{path} doesn't end with the sites list's closing brackets")
    existing = json.loads(text)["sites"]
    ids = {s["id"] for s in existing} | {l["id"] for s in existing for l in s["launches"]}
    new = json.load(open(new_path))
    for s in new:
        for i in [s["id"], *(l["id"] for l in s["launches"])]:
            if i in ids:
                sys.exit(f"{i} is already in {path}")
            ids.add(i)
    text = re.sub(r'"curatedOn": "[^"]*"', f'"curatedOn": "{datetime.date.today()}"', text, count=1)
    text = text[: -len(TAIL)] + ",\n" + ",\n".join(site(s) for s in new) + TAIL
    json.loads(text)
    open(path, "w").write(text)
    print(f"appended {len(new)} sites")


if __name__ == "__main__":
    main()
