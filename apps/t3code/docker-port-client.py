#!/usr/bin/env python3
"""Work-only localhost TCP ports through the authenticated guest-service relay."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import ssl
import struct


async def pump(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()


async def connection(reader, writer, host, context, port):
    upstream_writer = None
    try:
        upstream, upstream_writer = await asyncio.wait_for(asyncio.open_connection(host, 2377, ssl=context, server_hostname=host, ssl_handshake_timeout=5), 7)
        upstream_writer.write(struct.pack("!H", port))
        await upstream_writer.drain()
        tasks = [asyncio.create_task(pump(reader, upstream_writer)), asyncio.create_task(pump(upstream, writer))]
        _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    except (OSError, asyncio.TimeoutError):
        pass  # Guest pressure stops must not stop the T3 interface.
    finally:
        if upstream_writer:
            upstream_writer.close()
        writer.close()


async def main():
    certs = Path(os.environ["DOCKER_CERT_PATH"])
    host = os.environ["DOCKER_VM_HOST"]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", action="append", type=int, help="Explicit additional guest/local port; host whitelist still applies")
    args = parser.parse_args()
    ports = args.port or json.loads((certs / "ports.json").read_text())
    if not isinstance(ports, list) or len(ports) != len(set(ports)) or any(not isinstance(p, int) or not 1024 <= p <= 65535 or p in (2376, 2377, 3773, 6443) for p in ports):
        raise ValueError("invalid bounded localhost port list")
    context = ssl.create_default_context(cafile=certs / "ca.pem")
    context.load_cert_chain(certs / "cert.pem", certs / "key.pem")
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    servers = []
    try:
        for port in ports:
            server = await asyncio.start_server(lambda r, w, p=port: connection(r, w, host, context, p), "127.0.0.1", port)
            servers.append(server)
        await asyncio.gather(*(s.serve_forever() for s in servers))
    finally:
        for server in servers:
            server.close()
            await server.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())
