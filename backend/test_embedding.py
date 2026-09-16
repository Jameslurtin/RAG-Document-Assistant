from sentence_transformers import SentenceTransformer

model = SentenceTransformer("all-MiniLM-L6-v2")

text = "Django REST Framework is used for the backend."

embedding = model.encode(text)

print("Original text:")
print(text)

print("\nEmbedding:")
print(embedding)

print("\nVector dimension:")
print(len(embedding))