# Private remote access from a phone

The Agent is a self-hosted web service. For access away from home, use a private VPN overlay such as Tailscale or WireGuard rather than exposing port `18787` directly to the internet.

## Recommended setup

1. Install and authenticate the VPN client on the NAS host and phone using your own trusted account.
2. Confirm the NAS and phone can reach each other through the private VPN address.
3. Open `http://<NAS-VPN-IP>:18787` in the phone browser while the VPN is connected.
4. Use a strong, unique Agent management password. Keep device access and VPN membership limited to trusted users.
5. Verify the service is not reachable from the public internet and that the router has no port-forwarding rule for `18787`.

## Important notes

- The Agent's own HTTP listener does not provide TLS. A VPN tunnel encrypts traffic between enrolled devices; do not assume plain HTTP is safe outside that tunnel.
- Do not configure public reverse-proxy exposure without a separately reviewed TLS and access-control design.
- The app does not implement a cloud relay, account system, or remote-access broker.
- The automated test suite does not install or configure a VPN and does not validate a real NAS deployment.

This guide is deployment advice only; it does not change the server's bind address, firewall, router, VPN, or NAS configuration.
