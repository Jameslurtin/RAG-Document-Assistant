"""Provider tests use mocks only; no hosted API requests are sent."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend import llm


class ProviderTests(unittest.TestCase):
    def test_default_ollama_and_shared_prompt(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(llm.ollama, 'chat') as chat:
            chat.return_value = {'message': {'content': '  PostgreSQL.\n'}}
            self.assertEqual(llm.generate_answer('Database: PostgreSQL.', 'Which database?'), 'PostgreSQL.')
            arguments = chat.call_args.kwargs
            self.assertEqual(arguments['model'], 'llama3.2')
            self.assertEqual(arguments['options'], {'temperature': 0})
            self.assertEqual(arguments['messages'][0]['content'], llm.SYSTEM_PROMPT)

    def test_openai_responses_and_model_override(self):
        for model in [None, 'configured-model']:
            environment = {'LLM_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test-placeholder'}
            if model:
                environment['OPENAI_MODEL'] = model
            with self.subTest(model=model), patch.dict(os.environ, environment, clear=True), patch.object(llm, 'OpenAI') as factory:
                client = factory.return_value.__enter__.return_value
                client.responses.create.return_value = SimpleNamespace(output_text='  Answer.\n')
                self.assertEqual(llm.generate_answer('Context text', 'Question text'), 'Answer.')
                client.responses.create.assert_called_once_with(
                    model=model or 'gpt-5.6-luna',
                    instructions=llm.SYSTEM_PROMPT,
                    input='\nContext:\nContext text\n\nQuestion:\nQuestion text\n',
                )

    def test_missing_key_does_not_create_client(self):
        for key in [None, '', '   ']:
            environment = {'LLM_PROVIDER': 'openai'}
            if key is not None:
                environment['OPENAI_API_KEY'] = key
            with self.subTest(key=key), patch.dict(os.environ, environment, clear=True), patch.object(llm, 'OpenAI') as factory:
                with self.assertRaisesRegex(ValueError, 'OPENAI_API_KEY is required'):
                    llm.generate_answer('Context', 'Question')
                factory.assert_not_called()

    def test_unsupported_provider(self):
        with patch.dict(os.environ, {'LLM_PROVIDER': 'unsupported'}):
            with self.assertRaisesRegex(ValueError, 'Unsupported LLM provider: unsupported'):
                llm.generate_answer('Context', 'Question')

    def test_gemini_request_and_model_override(self):
        for model in [None, 'configured-model']:
            environment = {'LLM_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test-placeholder'}
            if model:
                environment['GEMINI_MODEL'] = model
            with self.subTest(model=model), patch.dict(os.environ, environment, clear=True), patch.object(llm.genai, 'Client') as factory:
                client = factory.return_value.__enter__.return_value
                client.models.generate_content.return_value = SimpleNamespace(text='  Answer.\n')
                self.assertEqual(llm.generate_answer('Context text', 'Question text'), 'Answer.')
                factory.assert_called_once_with(api_key='test-placeholder')
                arguments = client.models.generate_content.call_args.kwargs
                self.assertEqual(arguments['model'], model or 'gemini-2.5-flash')
                self.assertEqual(arguments['contents'], '\nContext:\nContext text\n\nQuestion:\nQuestion text\n')
                self.assertEqual(arguments['config'].system_instruction, llm.SYSTEM_PROMPT)
                self.assertEqual(arguments['config'].temperature, 0)

    def test_gemini_missing_key(self):
        for key in [None, '', '   ']:
            environment = {'LLM_PROVIDER': 'gemini'}
            if key is not None:
                environment['GEMINI_API_KEY'] = key
            with self.subTest(key=key), patch.dict(os.environ, environment, clear=True), patch.object(llm.genai, 'Client') as factory:
                with self.assertRaisesRegex(ValueError, 'GEMINI_API_KEY is required'):
                    llm.generate_answer('Context', 'Question')
                factory.assert_not_called()

    def test_gemini_empty_response(self):
        for text in [None, '', '  ']:
            with self.subTest(text=text), patch.dict(os.environ, {'LLM_PROVIDER': 'gemini', 'GEMINI_API_KEY': 'test-placeholder'}), patch.object(llm.genai, 'Client') as factory:
                client = factory.return_value.__enter__.return_value
                client.models.generate_content.return_value = SimpleNamespace(text=text)
                with self.assertRaisesRegex(ConnectionError, 'returned no answer'):
                    llm.generate_answer('Context', 'Question')


if __name__ == '__main__':
    unittest.main()
