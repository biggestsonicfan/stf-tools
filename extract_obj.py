#!/usr/bin/env python3
"""
Extract the raw PM image from a linked ADSP-21k COFF executable (.exe), using
cdump (g21k-binutils) to locate the section, then slicing the bytes out.

a21000 emits a *relocatable* .obj: every absolute jump, call and dm address is
segment-relative until ld21k (driven by an .ach placing seg_pmco at PM 0x20000)
resolves it.  So the thing worth comparing is the linked .exe, never the .obj.
Its section bytes are the big-endian 48-bit PM word stream -- i.e. the ROM
image, matching *_be.bin.

For each <name>.exe this writes <name>.bin and, if a reference <name>_be.bin is
found, reports whether they match byte-for-byte.

  cdump         --cdump PATH   or $CDUMP    (default: 'cdump' on PATH)
  reference dir --ref DIR      or $REF_DIR  (default: current directory)

The reference images are the game's and are not carried here; point --ref at
wherever you keep them.  Without one the .bin is still written, just not
compared.

Usage:
    python extract_obj.py                          # cpres1.exe cpres2.exe
    python extract_obj.py --ref ../roms foo.exe
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

PM_WORD_BYTES = 6


def find_cdump(explicit):
    for cand in (explicit, os.environ.get("CDUMP")):
        if cand:
            if os.path.exists(cand):
                return cand
            sys.exit(f"cdump not found at: {cand}")
    found = shutil.which("cdump") or shutil.which("cdump.exe")
    if found:
        return found
    sys.exit("cdump not found. Pass --cdump PATH or set $CDUMP "
             "(it ships in g21k/binutils/cdump).")


def cdump_sections(cdump, path):
    """[(name, s_scnptr, s_size)] parsed from cdump's Section Header block."""
    out = subprocess.run([cdump, path], capture_output=True, text=True).stdout
    lines = out.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == "Section Header")
    except StopIteration:
        raise RuntimeError(f"{path}: cdump produced no Section Header")
    end = next((i for i in range(start, len(lines))
                if lines[i].strip() == "Section Data"), len(lines))
    name_re = re.compile(r"^(\S+)\s+0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)\s*$")
    ptr_re = re.compile(r"^0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)\s+"
                        r"0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)")
    secs = []
    for i, ln in enumerate(lines[start:end]):
        if ln.lstrip().startswith("0x"):
            continue
        m = name_re.match(ln)
        if not m:
            continue
        nxt = lines[start + i + 1] if start + i + 1 < end else ""
        m2 = ptr_re.match(nxt)
        if not m2:
            continue
        secs.append((m.group(1), int(m2.group(1), 16), int(m.group(4), 16)))
    return secs


def extract(cdump, ref_dir, path):
    """True if a reference existed and matched."""
    blob = open(path, "rb").read()
    base = os.path.splitext(os.path.basename(path))[0]
    print(f"{path}  ({len(blob)} bytes)")
    matched = False
    for name, scnptr, size in cdump_sections(cdump, path):
        data = blob[scnptr:scnptr + size]
        outname = f"{base}.bin"
        with open(outname, "wb") as o:
            o.write(data)
        print(f"  section '{name}': off 0x{scnptr:X}, size 0x{size:X} "
              f"({size} bytes = {size // PM_WORD_BYTES} x 48-bit words) -> {outname}")
        ref = os.path.join(ref_dir, f"{base}_be.bin")
        if os.path.exists(ref):
            rb = open(ref, "rb").read()
            if data == rb:
                matched = True
                print(f"    vs {base}_be.bin: EXACT MATCH")
            else:
                print(f"    vs {base}_be.bin: DIFFERS (len {len(data)} vs {len(rb)}, "
                      f"{sum(a != b for a, b in zip(data, rb))} byte diffs)")
        else:
            print(f"    no {base}_be.bin in {ref_dir} -- written, not compared")
    return matched


def main():
    ap = argparse.ArgumentParser(
        description="Extract seg_pmco from a linked ADSP-21k COFF .exe and "
                    "compare it against a reference ROM image.")
    ap.add_argument("exes", nargs="*",
                    help="linked .exe files (default: cpres1.exe cpres2.exe)")
    ap.add_argument("--cdump", help="path to cdump[.exe]; else $CDUMP, else PATH")
    ap.add_argument("--ref", help="directory holding the reference *_be.bin "
                                  "images; else $REF_DIR, else .")
    args = ap.parse_args()

    cdump = find_cdump(args.cdump)
    ref_dir = args.ref or os.environ.get("REF_DIR") or "."
    exes = args.exes or ["cpres1.exe", "cpres2.exe"]

    rc = 0
    for a in exes:
        if os.path.exists(a):
            extract(cdump, ref_dir, a)
        else:
            print(f"  !! {a} not found", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
