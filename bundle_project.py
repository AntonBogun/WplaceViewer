import os

# List of relevant file extensions and filenames
EXTENSIONS = ['.html', '.js']
FILENAMES = ['CMakeLists.txt']
OUTPUT_FILE = 'project_bundle.txt'

files_to_bundle = []
for root, dirs, files in os.walk('.'):
    # Skip 'build' and similar directories
    dirs[:] = [d for d in dirs if d.lower() not in ['build', 'out', 'dist',"node_modules"]]
    for file in files:
        if any(file.endswith(ext) for ext in EXTENSIONS) or file in FILENAMES:
            files_to_bundle.append(os.path.join(root, file))

with open(OUTPUT_FILE, 'w', encoding='utf-8') as out:
    for file_path in files_to_bundle:
        out.write(f'--- {file_path} ---\n')
        with open(file_path, 'r', encoding='utf-8') as f:
            out.write(f.read())
            out.write('\n\n')
print(f'Bundled {len(files_to_bundle)} files into {OUTPUT_FILE}')
