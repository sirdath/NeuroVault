from neurovault_server.chunker import hierarchical_chunk, extract_wikilinks


def test_document_chunk():
    content = "This is a long document. " * 100
    chunks = hierarchical_chunk(content, "test-id")
    doc_chunks = [c for c in chunks if c["granularity"] == "document"]
    assert len(doc_chunks) == 1
    assert len(doc_chunks[0]["content"]) <= 2000


def test_paragraph_chunks():
    paragraphs = "\n\n".join(
        f"This is paragraph {i} with enough words to pass the minimum threshold for chunking purposes and it keeps going with more words to be sure." for i in range(5)
    )
    chunks = hierarchical_chunk(paragraphs, "test-id")
    para_chunks = [c for c in chunks if c["granularity"] == "paragraph"]
    assert len(para_chunks) >= 1


def test_sentence_chunks():
    content = "This is the first sentence with enough words to qualify. This is the second sentence also with enough words to qualify. The third sentence has plenty of words in it too."
    chunks = hierarchical_chunk(content, "test-id")
    sent_chunks = [c for c in chunks if c["granularity"] == "sentence"]
    assert len(sent_chunks) >= 1


def test_short_content_skips_paragraphs_and_sentences():
    content = "Short note."
    chunks = hierarchical_chunk(content, "test-id")
    # Should only have a document chunk
    assert len(chunks) == 1
    assert chunks[0]["granularity"] == "document"


def test_chunk_ids_are_unique():
    content = "A test.\n\nSecond paragraph with enough words to pass the threshold for inclusion.\n\nThird paragraph also with enough words to pass the minimum threshold."
    chunks = hierarchical_chunk(content, "test-id")
    ids = [c["id"] for c in chunks]
    assert len(ids) == len(set(ids))


def test_extract_wikilinks():
    content = "I use [[Python]] and [[React]] for this project. See also [[My Cat Luna]]."
    links = extract_wikilinks(content)
    assert "python" in links
    assert "react" in links
    assert "my cat luna" in links


def test_extract_wikilinks_empty():
    assert extract_wikilinks("No links here.") == []


def test_extract_wikilinks_ignores_empty_brackets():
    assert extract_wikilinks("Empty [[]] should be ignored") == []
