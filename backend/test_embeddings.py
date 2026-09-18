import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import embeddings


class EmbeddingTests(unittest.TestCase):
    def test_unsupported_provider(self):
        with patch.object(embeddings, '_PROVIDER', 'unknown'):
            with self.assertRaisesRegex(ValueError, 'Unsupported embedding provider'):
                embeddings.embed_query('question')

    def test_gemini_batches_and_query_task(self):
        with patch.object(embeddings, '_PROVIDER', 'gemini'), patch.dict(
            os.environ, {'GEMINI_API_KEY': 'test-key'}
        ), patch.object(embeddings.genai, 'Client') as factory:
            api = factory.return_value.__enter__.return_value.models.embed_content
            api.side_effect = lambda **kw: SimpleNamespace(embeddings=[
                SimpleNamespace(values=[1, 2]) for _ in kw['contents']
            ])
            self.assertEqual(embeddings.embed_texts(['chunk'] * 101), [[1.0, 2.0]] * 101)
            self.assertEqual([len(c.kwargs['contents']) for c in api.call_args_list], [100, 1])
            self.assertEqual(api.call_args.kwargs['config'].task_type, 'RETRIEVAL_DOCUMENT')
            self.assertEqual(api.call_args.kwargs['model'], embeddings._GEMINI_MODEL)
            self.assertEqual(embeddings.embed_query('question'), [1.0, 2.0])
            self.assertEqual(api.call_args.kwargs['config'].task_type, 'RETRIEVAL_QUERY')

    def test_missing_key_and_incomplete_response(self):
        with patch.object(embeddings, '_PROVIDER', 'gemini'), patch.dict(
            os.environ, {'GEMINI_API_KEY': ''}
        ):
            with self.assertRaisesRegex(ValueError, 'GEMINI_API_KEY'):
                embeddings.embed_query('question')
        with patch.object(embeddings, '_PROVIDER', 'gemini'), patch.dict(
            os.environ, {'GEMINI_API_KEY': 'test-key'}
        ), patch.object(embeddings.genai, 'Client') as factory:
            factory.return_value.__enter__.return_value.models.embed_content.return_value.embeddings = []
            with self.assertRaises(ConnectionError):
                embeddings.embed_texts(['chunk'])

    def test_local_delegation(self):
        with patch.object(embeddings, '_PROVIDER', 'local'), patch.object(embeddings, '_local_model') as model:
            model.return_value.encode.return_value.tolist.return_value = [[0.1, 0.2]]
            self.assertEqual(embeddings.embed_query('question'), [0.1, 0.2])
            model.return_value.encode.assert_called_once_with(['question'])

    def test_environment_changes_do_not_switch_active_model(self):
        provider, model = embeddings._PROVIDER, embeddings._GEMINI_MODEL
        with patch.dict(os.environ, {'EMBEDDING_PROVIDER': 'changed', 'GEMINI_EMBEDDING_MODEL': 'changed'}):
            self.assertEqual(embeddings._PROVIDER, provider)
            self.assertEqual(embeddings._GEMINI_MODEL, model)


if __name__ == '__main__':
    unittest.main()
