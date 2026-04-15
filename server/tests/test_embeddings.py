from neurovault_server.embeddings import Embedder


def test_encode_returns_384_floats(embedder: Embedder):
    vec = embedder.encode("Hello world")
    assert isinstance(vec, list)
    assert len(vec) == 384
    assert all(isinstance(v, float) for v in vec)


def test_encode_batch(embedder: Embedder):
    vecs = embedder.encode_batch(["Hello", "World", "Test"])
    assert len(vecs) == 3
    assert all(len(v) == 384 for v in vecs)


def test_singleton():
    a = Embedder.get()
    b = Embedder.get()
    assert a is b


def test_different_texts_produce_different_embeddings(embedder: Embedder):
    v1 = embedder.encode("The cat sat on the mat")
    v2 = embedder.encode("Quantum physics is fascinating")
    # They shouldn't be identical
    assert v1 != v2
