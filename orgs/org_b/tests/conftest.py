"""Make the org package importable without touching pyproject or the lockfile."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
