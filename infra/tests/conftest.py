import sys
from pathlib import Path

# Make `stacks` and `medapp_shared` importable when running `pytest` from the infra/ root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
