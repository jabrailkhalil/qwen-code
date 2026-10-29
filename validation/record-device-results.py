"""Record each real instrumentation testcase, including all skips."""
from collections import Counter
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

root = Path(sys.argv[1])
cases = []
for path in sorted((root / 'androidTest-results').rglob('TEST-*.xml')):
    tree = ET.parse(path)
    for case in tree.iter('testcase'):
        verdict = ('FAIL' if case.find('failure') is not None or case.find('error') is not None
                   else 'SKIP' if case.find('skipped') is not None else 'PASS')
        cases.append({'class': case.get('classname'), 'name': case.get('name'),
                      'verdict': verdict, 'file': str(path.relative_to(root))})
assert cases, 'No instrumentation testcases were produced; this is not a device pass'
identities = [(case['class'], case['name']) for case in cases]
assert len(set(identities)) == len(identities), 'Duplicate testcase reports require inspection'
result = {'source': 'dd8e94513b33848999ac39d324eea6f2dced77aa', 'api': 26,
          'total': len(cases), 'counts': dict(Counter(case['verdict'] for case in cases)),
          'cases': cases}
(root / 'device-results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps({key: value for key, value in result.items() if key != 'cases'}))
assert not result['counts'].get('FAIL'), 'Instrumentation failures remain failures'
assert result['counts'].get('PASS', 0), 'An all-skipped run is not a pass'
