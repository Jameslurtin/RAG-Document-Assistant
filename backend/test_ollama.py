import ollama

response = ollama.chat(
    model="llama3.2",
    messages=[
        {
            "role": "user",
              "content": """
Context:
Retrieval-Augmented Generation (RAG) is a technique that retrieves relevant
information from an external knowledge source before asking an LLM to generate
an answer.

Question:
What is RAG?

Answer using only the provided context and keep the answer to one sentence.
"""

        }
    ]
)

print(response["message"]["content"])