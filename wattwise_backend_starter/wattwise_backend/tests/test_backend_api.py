import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Ensure backend root is on sys.path
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

import httpx
from app import database
from app.main import app


class BackendAPITests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.prev_db = database.DB_PATH
        database.DB_PATH = os.path.join(cls.tmp.name, 'test.db')
        database.init_db()

    @classmethod
    def tearDownClass(cls):
        database.DB_PATH = cls.prev_db
        cls.tmp.cleanup()

    async def asyncSetUp(self):
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_health(self):
        r = await self.client.get('/health')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()['status'], 'ok')

    async def test_upload_analysis_and_history(self):
        csv = b'timestamp,kwh\n2026-10-01T00:00:00Z,1\n2026-10-01T01:00:00Z,2\n2026-10-01T02:00:00Z,1\n2026-10-01T03:00:00Z,1\n'
        r = await self.client.post(
            '/api/analyze',
            files={'file': ('readings.csv', io.BytesIO(csv), 'text/csv')},
            data={'electricity_rate': '10', 'avoidable_percent': '50'}
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()['result']['summary']['total_energy_kwh'], 5.0)

        r_history = await self.client.get('/api/analyses')
        self.assertEqual(r_history.status_code, 200)
        self.assertGreaterEqual(len(r_history.json()['items']), 1)

    async def test_reject_unsupported_format(self):
        r = await self.client.post(
            '/api/analyze',
            files={'file': ('readings.xyz', io.BytesIO(b'hello'), 'application/octet-stream')}
        )
        self.assertEqual(r.status_code, 415)


if __name__ == '__main__':
    unittest.main()
