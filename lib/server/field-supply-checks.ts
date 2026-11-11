// The verifier program comes from Hex and stays outside candidate source files.
export const fieldSupplyChecks = [
  ['order_status', 'New order page loads', 'security'],
  ['order_cache', 'New order response uses no-store', 'security'],
  ['receipt_cache', 'Completed order response uses no-store', 'security'],
  ['receipt_status', 'Completed order page loads', 'security'],
  ['home_status', 'Catalog loads', 'checkout'],
  ['catalog', 'Catalog lists the notebook', 'checkout'],
  ['cart_link', 'Catalog links to cart', 'checkout'],
  ['cookie', 'New browser receives a session cookie', 'checkout'],
  ['empty_cart', 'New cart is empty', 'checkout'],
  ['add_status', 'Add to cart redirects', 'checkout'],
  ['add_location', 'Add to cart redirects to cart', 'checkout'],
  ['cart_item', 'Cart displays the notebook', 'checkout'],
  ['cart_total', 'Cart total is AED 24', 'checkout'],
  ['checkout_status', 'Checkout redirects', 'checkout'],
  ['checkout_location', 'Checkout redirects to latest order', 'checkout'],
  ['receipt_item', 'Receipt displays the notebook', 'checkout'],
  ['cleared_cart', 'Checkout clears the cart', 'checkout'],
  ['asset_status', 'Stylesheet loads', 'assets'],
  ['asset_type', 'Stylesheet has a CSS media type', 'assets'],
  ['asset_cache', 'Stylesheet retains its baseline cache policy', 'assets'],
] as const;

export const fieldSupplyVerifier = String.raw`
import http.client, json, subprocess, sys, time
launch = """
import runpy, sys
from http.server import ThreadingHTTPServer
handler = runpy.run_path(sys.argv[1])['StoreHandler']
with ThreadingHTTPServer(('127.0.0.1', 0), handler) as server:
    print(server.server_port, flush=True)
    server.serve_forever()
"""
proc = subprocess.Popen(
    [sys.executable, '-I', '-B', '-c', launch, sys.argv[1]],
    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
)
try:
    port = int(proc.stdout.readline())
    def request(path, method='GET', body=None, cookie=''):
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
        try:
            connection.request(method, path, body, {'Cookie': cookie} if cookie else {})
            response = connection.getresponse()
            return response.status, dict((k.lower(), v) for k, v in response.getheaders()), response.read(100000).decode('utf-8', 'replace')
        finally:
            connection.close()
    def no_store(response):
        return 'no-store' in [part.strip() for part in response[1].get('cache-control', '').lower().split(',')]
    home = request('/')
    token = home[1].get('set-cookie', '').split(';', 1)[0]
    before = request('/order', cookie=token)
    empty = request('/cart', cookie=token)
    add = request('/cart', 'POST', 'item=notebook', token)
    cart = request('/cart', cookie=token)
    checkout = request('/checkout', 'POST', '', token)
    receipt = request('/order', cookie=token)
    after = request('/cart', cookie=token)
    css = request('/styles.css')
    asset_policy = css[1].get('cache-control', '')
    expected = sys.argv[2] if len(sys.argv) > 2 else asset_policy
    checks = dict(
        order_status=before[0] == 200, order_cache=no_store(before),
        receipt_status=receipt[0] == 200, receipt_cache=no_store(receipt),
        home_status=home[0] == 200, catalog='Field notebook' in home[2], cart_link='href="/cart"' in home[2],
        cookie=token.startswith('store_session='), empty_cart='Nothing here yet' in empty[2],
        add_status=add[0] == 303, add_location=add[1].get('location') == '/cart',
        cart_item='Field notebook' in cart[2], cart_total='Total AED 24' in cart[2],
        checkout_status=checkout[0] == 303, checkout_location=checkout[1].get('location') == '/order',
        receipt_item='Field notebook' in receipt[2], cleared_cart='Nothing here yet' in after[2],
        asset_status=css[0] == 200, asset_type=css[1].get('content-type', '').startswith('text/css'),
        asset_cache=asset_policy == expected and 'no-store' not in asset_policy.lower(),
    )
    print(json.dumps(dict(checks=checks, assetPolicy=asset_policy)), flush=True)
finally:
    proc.kill()
    proc.wait()
`;
