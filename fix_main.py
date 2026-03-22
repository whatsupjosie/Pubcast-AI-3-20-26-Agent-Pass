import re
from pathlib import Path

main_js = Path('main.js')
content = main_js.read_text(encoding='utf-8')

# Remove the two duplicate require lines that our patch added
# (path and execFile are already declared earlier in main.js)
content = content.replace(
    'const { execFile } = require("child_process");\nconst path = require("path");\n',
    ''
)

main_js.write_text(content, encoding='utf-8')
print('fixed')
