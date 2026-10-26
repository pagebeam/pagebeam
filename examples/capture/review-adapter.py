import argparse
import json
import pathlib
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--cli', required=True)
parser.add_argument('--cwd', required=True)
parser.add_argument('--environment', required=True)
parser.add_argument('--target', required=True)
parser.add_argument('--base')
parser.add_argument('--journey', action='append', default=[])
parser.add_argument('--config')
args = parser.parse_args()

command = ['node', str(pathlib.Path(args.cli).resolve()), 'capture', '--cwd', args.cwd,
           '--environment', args.environment, '--target', args.target, '--json']
if args.base:
    command.extend(['--base', args.base])
if args.config:
    command.extend(['--config', args.config])
for journey in args.journey:
    command.extend(['--journey', journey])
completed = subprocess.run(command, capture_output=True, text=True, check=False)
try:
    result = json.loads(completed.stdout)
except json.JSONDecodeError:
    sys.stderr.write(completed.stderr)
    raise SystemExit(completed.returncode or 2)

report = result['report']
directory = pathlib.Path(result['directory']).resolve()
captures = []
for journey in report['results']:
    for step in journey['steps']:
        if not step.get('file'):
            continue
        file = (directory / journey['journey'] / journey['viewport'] / step['file']).resolve()
        if not file.is_relative_to(directory):
            raise ValueError('Capture path leaves the artifact directory')
        captures.append({'journey': journey['journey'], 'viewport': journey['viewport'],
                         'step': step['step'], 'status': step['status'], 'file': str(file)})

print(json.dumps({'revision': report['revision'], 'status': report['status'],
                  'selection': report['selection'], 'backend': report.get('backend'),
                  'errors': report['errors'], 'captures': captures,
                  'report': str(directory / 'report.json'),
                  'gallery': str(directory / 'index.html')}))
raise SystemExit(completed.returncode)
