"""Inspect raw Vitest records without treating filtered tests as passing."""
import json
from pathlib import Path
import sys

mode, filename, arm = sys.argv[1:]
path = Path(filename)
data = json.loads(path.read_text())
cases = [case for suite in data['testResults'] for case in suite['assertionResults']]
passed = [case for case in cases if case['status'] == 'passed']
failed = [case for case in cases if case['status'] == 'failed']
pending = [case for case in cases if case['status'] not in ['passed', 'failed']]
selector = 'launches once under concurrent requests, survives its launcher, and cleanly retires'

if mode == 'container':
    assert data['numFailedTests'] == len(failed) == 1
    assert not passed
    assert selector in failed[0]['fullName']
    message = '\n'.join(failed[0]['failureMessages'])
    assert 'ENOENT' in message and '/etc/machine-id' in message
    assert data.get('numRuntimeErrorTestSuites', 0) == 0
else:
    assert data['numFailedTests'] == 0 and not failed and passed
    assert data.get('numRuntimeErrorTestSuites', 0) == 0
    if mode == 'host':
        assert len(passed) == 1 and selector in passed[0]['fullName']
    if mode == 'webshell':
        required = [
            '/client/components/sidebar/StandaloneRecents.test.tsx',
            '/client/components/sidebar/WebShellSidebar.workspace-removal.test.tsx',
            '/client/components/sidebar/WebShellSidebar.brand.test.tsx',
        ]
        if arm == 'mobile':
            required.append('/client/utils/saveBlob.test.ts')
        for suffix in required:
            suite = next(s for s in data['testResults'] if s['name'].replace('\\', '/').endswith(suffix))
            assert any(case['status'] == 'passed' for case in suite['assertionResults'])

result = {
    'arm': arm, 'mode': mode, 'passed': len(passed), 'failed': len(failed),
    'filteredOrPending': len(pending), 'raw': str(path),
    'failedNames': [case['fullName'] for case in failed],
    'verified': True,
}
path.with_suffix('.verified.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
