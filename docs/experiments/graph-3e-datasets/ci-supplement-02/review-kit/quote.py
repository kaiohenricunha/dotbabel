"""Print a ready-to-paste evidence object with the byte-exact quote: quote.py <input_dir> <relative_path> <start> <end> [log|context]"""
import json, pathlib, re, sys
base, rel, start, end = pathlib.Path(sys.argv[1]).resolve(), sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
kind = sys.argv[5] if len(sys.argv) > 5 else 'log'
file = (base / rel).resolve()
if base not in file.parents or not file.is_file() or start < 1 or end < start: sys.exit('bad path or range')
lines = re.split(r'\r?\n', file.read_text(encoding='utf-8'))
if end > len(lines): sys.exit(f'file has {len(lines)} lines')
print(json.dumps({'kind': kind, 'path': rel, 'line_start': start, 'line_end': end, 'quote': '\n'.join(lines[start - 1:end])}, ensure_ascii=False))
