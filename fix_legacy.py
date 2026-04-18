import re

with open('server_legacy.js', 'r') as f:
    code = f.read()

# Remove express, CORS, and limits setup from legacy
code = re.sub(r"const app = express\(\)", "", code)
code = re.sub(r"app\.use\(cors\(\{.*?\}\)\)", "", code)
code = re.sub(r"app\.use\(express\.json\(\{ limit: '10mb' \}\)\)", "", code)

# Remove the trailing app.listen
code = re.sub(r"app\.listen\(PORT, \(\) => .*?\n", "", code)

# Wrap all app.get, app.post inside export function setupLegacyRoutes(app)
# We can do this safely by replacing the first instance of app.get('/api/health'...)
# with "export function setupLegacyRoutes(app) {\napp.get(..."
# and appending a closing "}" at the end.

split_str = "app.get('/api/health', (_req, res) => {"
parts = code.split(split_str)
if len(parts) == 2:
    new_code = parts[0] + "export function setupLegacyRoutes(app) {\n" + split_str + parts[1] + "\n}\n"
    with open('server_legacy.js', 'w') as f:
        f.write(new_code)
else:
    print("Could not find /api/health")

