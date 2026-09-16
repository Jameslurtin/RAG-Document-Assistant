"""Run from the project root: python -m unittest backend.test_workflow -v.

Set RAG_LIVE_TESTS=1 to also test the existing PDFs with local llama3.2.
"""
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from backend import main, rag


def pdf_bytes(text=None):
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    if text:
        font = DictionaryObject({
            NameObject('/Type'): NameObject('/Font'),
            NameObject('/Subtype'): NameObject('/Type1'),
            NameObject('/BaseFont'): NameObject('/Helvetica'),
        })
        page[NameObject('/Resources')] = DictionaryObject({
            NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})
        })
        stream = DecodedStreamObject()
        stream.set_data(f'BT /F1 12 Tf 40 700 Td ({text}) Tj ET'.encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = patch.object(main, 'DOCUMENTS_DIR', Path(self.temp.name))
        self.directory.start()
        self.client = TestClient(main.app)
        self.clear_index()

    def clear_index(self):
        if rag.collection is not None:
            rag.client.delete_collection(rag.collection.name)
            rag.collection = None

    def tearDown(self):
        self.clear_index()
        self.directory.stop()
        self.temp.cleanup()

    def upload(self, content, filename='sample.pdf'):
        return self.client.post('/upload', files={'file': (filename, content, 'application/pdf')})

    def test_validation_and_cors(self):
        self.assertEqual(self.client.post('/ask', json={'question': 'hello'}).status_code, 400)
        for question in ['', '   ', '\n\t']:
            self.assertEqual(self.client.post('/ask', json={'question': question}).status_code, 422)
        self.assertEqual(self.upload(b'hello', 'notes.txt').status_code, 415)
        self.assertEqual(self.upload(b'not a PDF').status_code, 415)
        self.assertEqual(self.upload(b'').status_code, 422)
        self.assertEqual(self.upload(b'%PDF-broken').status_code, 422)
        self.assertEqual(self.upload(pdf_bytes()).status_code, 422)
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])
        response = self.client.options('/ask', headers={
            'Origin': 'http://localhost:5173',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
        })
        self.assertEqual(response.headers['access-control-allow-origin'], 'http://localhost:5173')

    def test_replacement_sources_and_failed_upload(self):
        first = self.upload(pdf_bytes('The first document uses PostgreSQL.'), '../same.pdf')
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['filename'], 'same.pdf')
        self.assertEqual(first.json()['chunks_stored'], 1)
        old_name = rag.collection.name
        second = self.upload(pdf_bytes('The second document uses SQLite.'), 'same.pdf')
        self.assertEqual(second.status_code, 200, second.text)
        self.assertNotEqual(old_name, rag.collection.name)
        self.assertEqual(rag.collection.count(), 1)
        self.assertNotIn(old_name, [item.name for item in rag.client.list_collections()])
        with patch.object(rag.ollama, 'chat', return_value={'message': {'content': 'SQLite.'}}) as chat:
            response = self.client.post('/ask', json={'question': ' What database is used? '})
            self.assertEqual(response.status_code, 200, response.text)
            source = response.json()['sources'][0]
            self.assertEqual(source['page'], 1)
            self.assertEqual(source['filename'], 'same.pdf')
            self.assertIn('SQLite', source['text'])
            self.assertNotIn('PostgreSQL', str(response.json()))
            prompt = chat.call_args.kwargs['messages'][1]['content']
            self.assertIn('SQLite', prompt)
            self.assertNotIn('PostgreSQL', prompt)
        active_name = rag.collection.name
        self.assertEqual(self.upload(pdf_bytes()).status_code, 422)
        with patch.object(rag.embedding_model, 'encode', side_effect=RuntimeError('test failure')):
            self.assertEqual(self.upload(pdf_bytes('Replacement content.')).status_code, 500)
        self.assertEqual(rag.collection.name, active_name)
        self.assertEqual(len(list(Path(self.temp.name).glob('*.pdf'))), 2)
        with patch.object(rag.ollama, 'chat', side_effect=ConnectionError('offline')):
            self.assertEqual(self.client.post('/ask', json={'question': 'Database?'}).status_code, 503)

    @unittest.skipUnless(os.environ.get('RAG_LIVE_TESTS') == '1', 'Enable RAG_LIVE_TESTS for local Ollama')
    def test_live_pdf_workflow(self):
        documents = Path(__file__).parent / 'documents'
        first = documents / 'Presentation - Introducing Our New Application Today.pdf'
        second = next(documents.glob('Software*.pdf'))
        response = self.upload(first.read_bytes(), first.name)
        self.assertEqual(response.status_code, 200, response.text)
        print('First upload:', response.json(), flush=True)
        answer = self.client.post('/ask', json={'question': 'What database does FreelanceHub use?'})
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertIn('postgresql', answer.json()['answer'].lower())
        self.assertEqual(len(answer.json()['sources']), 4)
        self.assertTrue(all(s['filename'] == first.name and s['page'] >= 1 for s in answer.json()['sources']))
        print('Known answer:', answer.json()['answer'], flush=True)
        unknown = self.client.post('/ask', json={'question': 'What is the exact population of Neptune?'})
        self.assertEqual(unknown.status_code, 200, unknown.text)
        self.assertEqual(unknown.json()['answer'], "I don't know based on the document.")
        print('Unknown answer:', unknown.json()['answer'], flush=True)
        response = self.upload(second.read_bytes(), second.name)
        self.assertEqual(response.status_code, 200, response.text)
        print('Second upload:', response.json(), flush=True)
        answer = self.client.post('/ask', json={'question': 'What does SDLC stand for?'})
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertIn('software development life cycle', answer.json()['answer'].lower())
        self.assertTrue(all(s['filename'] == second.name for s in answer.json()['sources']))
        print('Second document answer:', answer.json()['answer'], flush=True)
        stale = self.client.post('/ask', json={'question': 'What database does FreelanceHub use?'})
        self.assertEqual(stale.status_code, 200, stale.text)
        self.assertEqual(stale.json()['answer'], "I don't know based on the document.")
        self.assertTrue(all(s['filename'] == second.name for s in stale.json()['sources']))
        print('Old document question:', stale.json()['answer'], flush=True)


if __name__ == '__main__':
    unittest.main()
