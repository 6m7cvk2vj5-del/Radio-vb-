#!/usr/bin/env python3
"""Run every live Dial station through the relay and report what each one returns.

    python3 tools/check_relay.py https://your-worker.workers.dev
    python3 tools/check_relay.py https://your-worker.workers.dev --page https://6m7cvk2vj5-del.github.io/Radio-vb-/
    python3 tools/check_relay.py https://your-worker.workers.dev --file index.html --only soma,nts

Reads the station list from the published Dial page (or a local index.html), asks the relay's
/icy?debug=1 endpoint about each live stream, and prints one line per station plus a summary.
Uses only the Python standard library. Finite files (talks, meditations) and HLS streams are
skipped, since they carry no embedded titles.
"""
import argparse, json, re, ssl, subprocess, sys, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

DEFAULT_PAGE = 'https://6m7cvk2vj5-del.github.io/Radio-vb-/'
SKIP_NETWORKS = {'meditate', 'slaa', 'cbc', 'bbc'}      # finite files / HLS
LINE = re.compile(r"\{\s*network:\s*'(\w+)',\s*name:\s*(?:'([^']*)'|\"([^\"]*)\")(.*)")
URL = re.compile(r"\b(url|lowUrl):\s*(?:'([^']+)'|\"([^\"]+)\")")


USE_CURL = False


def fetch_text(url, timeout=20):
    """GET a URL and return the body. Verifies certificates. If Python can't (python.org builds
    on macOS often ship without root certificates), retries once with the system `curl`."""
    global USE_CURL
    if not USE_CURL:
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'dial-relay-check'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('utf-8')
        except urllib.error.URLError as e:
            if not isinstance(e.reason, ssl.SSLCertVerificationError):
                raise
            USE_CURL = True
            print('(Python has no root certificates here; using the system curl instead)', file=sys.stderr)
    out = subprocess.run(['curl', '-sS', '-f', '-L', '--max-time', str(timeout), '-A', 'dial-relay-check', url],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError('curl failed (%s): %s' % (out.returncode, out.stderr.strip()))
    return out.stdout


def load_html(args):
    if args.file:
        return open(args.file, encoding='utf-8').read()
    return fetch_text(args.page)


def parse_stations(html):
    out = []
    for line in html.splitlines():
        m = LINE.search(line)
        if not m:
            continue
        network, name = m.group(1), m.group(2) or m.group(3)
        urls = {k: (a or b) for k, a, b in URL.findall(m.group(4))}
        if 'url' not in urls:          # pool stations have no url of their own
            continue
        out.append({'network': network, 'name': name, 'url': urls['url'], 'low': urls.get('lowUrl')})
    return out


def ask(relay, url, timeout=20):
    q = relay.rstrip('/') + '/icy?debug=1&u=' + urllib.parse.quote(url, safe='')
    try:
        return json.loads(fetch_text(q, timeout))
    except Exception as e:                       # network / HTTP / bad JSON
        return {'error': str(e)}


def summarize(d):
    if 'error' in d and 'trace' not in d:
        return 'ERROR', '-', d['error']
    if 'trace' not in d and 'error' not in d:
        return 'OLDWORKER', '-', 'relay replied without debug info: redeploy the latest relay/worker.js in Cloudflare'
    t = d.get('trace', {})
    res = d.get('result')
    if res and res.get('title'):
        who = (res.get('artist') + ' - ' if res.get('artist') else '') + res['title']
        return 'TITLE', t.get('metaint', '-'), who
    why = t.get('stoppedBecause') or t.get('error') or 'no title'
    if t.get('status') not in (None, 200):
        why = 'HTTP %s from station; %s' % (t.get('status'), why)
    return 'NONE', t.get('metaint') or '-', why


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('relay', help='your Worker address, e.g. https://dial-relay.you.workers.dev')
    ap.add_argument('--page', default=DEFAULT_PAGE, help='published Dial page to read stations from')
    ap.add_argument('--file', help='read stations from a local index.html instead')
    ap.add_argument('--only', help='comma-separated network ids to test, e.g. soma,club')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--verbose', action='store_true', help='also print the station response headers for every failure')
    ap.add_argument('--curl', action='store_true', help='always use the system curl for network requests')
    args = ap.parse_args()
    global USE_CURL
    USE_CURL = args.curl

    stations = [s for s in parse_stations(load_html(args))
                if s['network'] not in SKIP_NETWORKS
                and not re.search(r'\.m3u8(\?|$)', s['url'])
                and 'archive.org' not in s['url']]
    if args.only:
        keep = set(args.only.split(','))
        stations = [s for s in stations if s['network'] in keep]
    if not stations:
        sys.exit('no stations found to test')

    print('Testing %d live stations through %s\n' % (len(stations), args.relay))
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        results = list(ex.map(lambda s: ask(args.relay, s['url']), stations))

    counts = {'TITLE': 0, 'NONE': 0, 'ERROR': 0, 'OLDWORKER': 0}
    for s, d in zip(stations, results):
        kind, metaint, detail = summarize(d)
        counts[kind] += 1
        print('%-6s %-9s %-30s metaint=%-6s %s' % (kind, s['network'], s['name'][:30], metaint, detail))
        if kind == 'OLDWORKER' and counts['OLDWORKER'] == len(stations):
            print('\nThe Worker in Cloudflare is an old version that does not support debug=1.')
            print('Open relay/worker.js from the repo, paste ALL of it into the Worker\'s "Edit code", press Deploy, then run this again.')
            return
        if args.verbose and kind != 'TITLE':
            t = d.get('trace', {})
            print('         url=%s status=%s blocks=%s headers=%s' % (s['url'], t.get('status'), t.get('blocks'), json.dumps(t.get('headers', {}))))
    print('\nSummary: %d returned a title, %d returned nothing, %d errors'
          % (counts['TITLE'], counts['NONE'], counts['ERROR']))


if __name__ == '__main__':
    main()
