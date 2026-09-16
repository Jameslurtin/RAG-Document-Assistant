import chromadb

client = chromadb.Client()

collection = client.create_collection(name="test_collection")

collection.add(
    documents=[
        "Django REST Framework is used for the backend.",
        "Angular is used for the frontend.",
        "PostgreSQL is used for data storage."
    ],
    ids=[
        "doc1",
        "doc2",
        "doc3"
    ]
)

print("Documents stored:", collection.count())
results = collection.query(
    query_texts=["What database does the application use?"],
    n_results=1
)

print("\nQuestion:")
print("What database does the application use?")

print("\nMost relevant document:")
print(results["documents"][0][0])