from pypdf import PdfReader
from sentence_transformers import SentenceTransformer
import chromadb
import ollama
reader = PdfReader("backend/documents/Presentation - Introducing Our New Application Today.pdf")

full_text = ""

for page in reader.pages:
    text = page.extract_text()

    if text:
        full_text += text + "\n"

chunk_size = 500
chunk_overlap = 100

chunks = []

step = chunk_size - chunk_overlap

for i in range(0, len(full_text), step):
    chunk = full_text[i:i + chunk_size]
    chunks.append(chunk)

print("Total characters:", len(full_text))
print("Total chunks:", len(chunks))

print("\n--- CHUNK 1 ---")
print(chunks[0])

print("\n--- CHUNK 2 ---")
print(chunks[1])

model = SentenceTransformer("all-MiniLM-L6-v2")

embeddings = model.encode(chunks)

print("\nNumber of embeddings:", len(embeddings))
print("Dimension of each embedding:", len(embeddings[0]))
client = chromadb.Client()

collection = client.create_collection(
    name="freelancehub"
)

ids = []

for i in range(len(chunks)):
    ids.append(f"chunk_{i}")

collection.add(
    ids=ids,
    documents=chunks,
    embeddings=embeddings.tolist()
)

print("\nDocuments stored in ChromaDB:", collection.count())
question = "who is CEO of freelancehub "

question_embedding = model.encode(question)

results = collection.query(
    query_embeddings=[question_embedding.tolist()],
    n_results=4
)

print("\nQuestion:")
print(question)

print("\nRetrieved chunks:")

for document in results["documents"][0]:
    print("\n---")
    print(document)

    context = "\n\n".join(results["documents"][0])

prompt = f"""
You are a document question-answering assistant.

Answer the question using only the context provided below.
If the answer is not in the context, say "I don't know based on the document."

Context:
{context}

Question:
{question}

Answer:
"""

response = ollama.chat(
    model="llama3.2",
    messages=[
        {
            "role": "user",
            "content": prompt
        }
    ]
)

print("\nRAG Answer:")
print(response["message"]["content"])