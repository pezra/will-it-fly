"""Print a KML file's folders and placemarks: name, geometry, first coordinates, description.

Usage: python3 -I kml_summary.py map.kml

Coordinates are printed as KML has them, longitude first.
"""

import sys
import xml.etree.ElementTree as ET

NS = {"k": "http://www.opengis.net/kml/2.2"}
GEOMETRIES = ("Point", "LineString", "Polygon")


def local(tag: str) -> str:
    return tag.split("}")[1] if "}" in tag else tag


def walk(element: ET.Element, depth: int = 0) -> None:
    pad = "  " * depth
    for child in element:
        tag = local(child.tag)
        if tag == "Folder":
            print(f"{pad}FOLDER {child.findtext('k:name', namespaces=NS)}")
            walk(child, depth + 1)
        elif tag == "Placemark":
            name = child.findtext("k:name", namespaces=NS)
            geometry = [local(g.tag) for g in child.iter() if local(g.tag) in GEOMETRIES]
            coords = (child.findtext(".//k:coordinates", namespaces=NS) or "").split()
            more = "..." if len(coords) > 3 else ""
            print(f"{pad}- {name!r} [{','.join(geometry)}] {coords[:3]}{more} n={len(coords)}")
            description = child.findtext("k:description", namespaces=NS)
            if description:
                print(f"{pad}    DESC: {description.strip()}")
            for data in child.findall(".//k:Data", namespaces=NS):
                print(f"{pad}    DATA {data.get('name')}: {data.findtext('k:value', namespaces=NS)}")


def main() -> None:
    root = ET.parse(sys.argv[1]).getroot()
    document = root.find("k:Document", NS)
    print(document.findtext("k:name", namespaces=NS))
    walk(document)


if __name__ == "__main__":
    main()
