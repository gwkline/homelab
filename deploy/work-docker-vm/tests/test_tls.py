"""Real TCP/mTLS fixture for the fixed guest-service selector."""
import asyncio
from pathlib import Path
import shutil
import ssl
import struct
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import runtime


@unittest.skipUnless(shutil.which('openssl'), 'requires openssl')
class RelayTLS(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        def run(*args):
            subprocess.run(['openssl', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.root/'ca.key'), '-out', str(self.root/'ca.pem'), '-days', '1', '-subj', '/CN=fixture-ca')
        for name, eku in [('server','serverAuth'), ('client','clientAuth')]:
            run('req','-newkey','rsa:2048','-nodes','-keyout',str(self.root/(name+'.key')),'-out',str(self.root/(name+'.csr')),'-subj','/CN='+name)
            (self.root/(name+'.ext')).write_text('extendedKeyUsage='+eku+'\nsubjectAltName=IP:127.0.0.1\n')
            run('x509','-req','-in',str(self.root/(name+'.csr')),'-CA',str(self.root/'ca.pem'),'-CAkey',str(self.root/'ca.key'),'-CAcreateserial','-out',str(self.root/(name+'.pem')),'-days','1','-extfile',str(self.root/(name+'.ext')))
        self.backend_calls = 0
        async def backend(reader,writer):
            self.backend_calls += 1
            try:
                data=await reader.read(64)
                writer.write(data);await writer.drain()
            finally:writer.close()
        self.backend = await asyncio.start_server(backend,'127.0.0.1',0)
        port=self.backend.sockets[0].getsockname()[1]
        self.config={'ports':{'18080':port}}
        context=ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        context.load_verify_locations(self.root/'ca.pem')
        context.load_cert_chain(self.root/'server.pem',self.root/'server.key')
        context.verify_mode=ssl.CERT_REQUIRED
        self.server=await asyncio.start_server(lambda r,w:runtime.server_connection(r,w,self.config),'127.0.0.1',0,ssl=context,ssl_handshake_timeout=3)
        self.port=self.server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close();self.backend.close()
        await self.server.wait_closed();await self.backend.wait_closed()
        self.tmp.cleanup()

    def context(self,cert=None):
        c=ssl.create_default_context(cafile=self.root/'ca.pem')
        if cert:c.load_cert_chain(self.root/(cert+'.pem'),self.root/(cert+'.key'))
        return c

    async def request(self,context,port):
        reader,writer=await asyncio.wait_for(asyncio.open_connection('127.0.0.1',self.port,ssl=context,server_hostname='127.0.0.1'),3)
        try:
            writer.write(struct.pack('!H',port)+b'real-tls-relay');await writer.drain()
            return await asyncio.wait_for(reader.read(64),3)
        finally:
            writer.close()
            try:await writer.wait_closed()
            except (OSError,ssl.SSLError):pass

    async def test_authenticated_fixed_port_and_unlisted_port(self):
        self.assertEqual(await self.request(self.context('client'),18080),b'real-tls-relay')
        self.assertEqual(self.backend_calls,1)
        self.assertEqual(await self.request(self.context('client'),22),b'')
        self.assertEqual(self.backend_calls,1)

    async def test_missing_cert_and_server_eku_cannot_authenticate(self):
        for context in [self.context(),self.context('server')]:
            try:data=await self.request(context,18080)
            except (OSError,ssl.SSLError,ConnectionError):data=b''
            self.assertEqual(data,b'')
        self.assertEqual(self.backend_calls,0)


if __name__=='__main__':unittest.main()
