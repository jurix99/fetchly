"""Point the app's CONFIG_DIR at a throwaway temp dir *before* any app module is
imported, so tests never touch a real /config and db.init() can write freely."""

import os
import tempfile

os.environ.setdefault("CONFIG_DIR", tempfile.mkdtemp(prefix="fetchly-tests-"))
