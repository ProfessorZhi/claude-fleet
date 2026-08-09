"""
Test suite package for agent metrics collector.
"""

import sys
from pathlib import Path

# Automatically add src directory to sys.path
src_dir = Path(__file__).resolve().parent.parent / "src"
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))
