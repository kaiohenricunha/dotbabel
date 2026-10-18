"""One bounded Linux atomic exchange on an explicitly inherited directory fd.

No shell, settings, credentials, environment inspection, network, or fallback rename.
Python runs in isolated mode; the Node caller retains objects on every ambiguous exit.
"""
import ctypes
import os
import stat
import sys


def main():
    if len(sys.argv) != 3:
        return 64
    names = sys.argv[1:]
    if any(not name or name in (".", "..") or "/" in name or "\x00" in name for name in names):
        return 64
    if not stat.S_ISDIR(os.fstat(3).st_mode):
        return 2
    libc = ctypes.CDLL(None, use_errno=True)
    operation = getattr(libc, "renameat2", None)
    if operation is None:
        return 2
    operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    operation.restype = ctypes.c_int
    return 0 if operation(3, os.fsencode(names[0]), 3, os.fsencode(names[1]), 2) == 0 else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(2)
