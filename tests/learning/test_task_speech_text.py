"""Device-local read-aloud must retain the complete supported question."""

from dataclasses import FrozenInstanceError

import pytest

from deeptutor.learning.teaching_analysis.task_speech_text import (
    MAX_RAW_CHARS,
    MAX_SPOKEN_CHARS,
    TaskSpeechText,
    TaskSpeechUnsupported,
    prepare_task_speech,
)


@pytest.mark.parametrize(
    ("locale", "expected"),
    [
        ("zh", "2分之1 加 3分之1"),
        ("en", "1 over 2 plus 1 over 3"),
    ],
)
def test_fraction_order_is_locale_specific_and_does_not_calculate(locale, expected):
    result = prepare_task_speech(r"$\frac{1}{2}+\frac{1}{3}$", locale)
    assert result == TaskSpeechText(expected, locale)
    assert "5/6" not in result.text
    with pytest.raises(FrozenInstanceError):
        result.text = "changed"


@pytest.mark.parametrize(
    "opener,closer", [("$", "$"), ("$$", "$$"), (r"\(", r"\)"), (r"\[", r"\]")]
)
def test_supported_math_delimiters_read_the_complete_island(opener, closer):
    assert prepare_task_speech(f"Compute{opener}8+8{closer}now.", "en").text == (
        "Compute 8 plus 8 now."
    )


@pytest.mark.parametrize(
    ("question", "locale", "expected"),
    [
        ("计算8+8，比较1/4与1/6。", "zh", "计算8 加 8，比较4分之1与6分之1。"),
        ("Compute 8-3×2÷5=2.", "en", "Compute 8 minus 3 times 2 divided by 5 equals 2."),
        ("计算（8+8）÷2。", "zh", "计算左括号 8 加 8 右括号 除以 2。"),
        ("８＋８＝？", "zh", "8 加 8 等于 问号"),
        ("x^2 + y³ = ?", "en", "x squared plus y cubed equals question mark"),
        (r"$x^{3}-2^2$", "zh", "x 的立方 减 2 的平方"),
        ("8+8=__", "en", "8 plus 8 equals blank"),
        ("8+8=□", "zh", "8 加 8 等于 空格"),
        ("Fill □.", "en", "Fill blank."),
        (r"$3 \times 4 \div 2 \cdot 1$", "en", "3 times 4 divided by 2 times 1"),
        (r"$\left(1+2\right)=3$", "zh", "左括号 1 加 2 右括号 等于 3"),
        (r"$1\, +\quad 2$", "en", "1 plus 2"),
        (r"$-3+2$", "zh", "负3 加 2"),
        ("Use - 3 rather than 3.", "en", "Use minus 3 rather than 3."),
        (r"$\frac{1}{0}$", "en", "1 over 0"),
        ("total_count+1", "en", "total_count plus 1"),
        ("1.5+2.25", "zh", "1.5 加 2.25"),
        ("Compute $.5+1$.", "en", "Compute .5 plus 1."),
    ],
)
def test_elementary_notation_is_preserved_as_speech(question, locale, expected):
    assert prepare_task_speech(question, locale).text == expected


@pytest.mark.parametrize("command", [r"\frac", r"\dfrac", r"\tfrac"])
def test_supported_fraction_spellings(command):
    assert prepare_task_speech(f"${command}{{1}}{{4}}$", "zh").text == "4分之1"


@pytest.mark.parametrize(
    ("question", "locale", "expected"),
    [
        (
            r"$\frac{1+2}{3-4}$",
            "zh",
            "左括号 3 减 4 右括号 分之 左括号 1 加 2 右括号",
        ),
        (
            r"$\frac{1}{\frac{2}{3}}$",
            "en",
            "1 over open parenthesis 2 over 3 close parenthesis",
        ),
        (
            r"$\frac{\frac{1}{2}}{3}$",
            "zh",
            "3 分之 左括号 2分之1 右括号",
        ),
        (
            r"$(x+1)^2$",
            "en",
            "open parenthesis x plus 1 close parenthesis squared",
        ),
        (
            r"$1/2/3$",
            "en",
            "open parenthesis 1 over 2 close parenthesis over 3",
        ),
    ],
)
def test_nested_structure_keeps_audible_group_boundaries(question, locale, expected):
    assert prepare_task_speech(question, locale).text == expected


@pytest.mark.parametrize("locale", ["en", "zh"])
@pytest.mark.parametrize(
    "question",
    [
        "Turn over the page. The plus and minus words are part of this sentence.",
        "Read student_id, file_name, __init__, case-12 and long-term.",
        "Date: 11/14; 日期为1/4; 2026/11/14; 11/14/2026; 2026-11-14; 2026-11.",
        "日期２０２６/１１/１４。Date 2026−11−14 and 2026–11–14.",
        "Open https://example.org/1/4?q=3/5 and www.example.org/1/6.",
        r"Read C:\work\1\4.txt and D:/work/1/4 or \\server\folder\1/4.",
        "Read /tmp/1/4, ./data/1/6, ../data/1/8 or student/1/2.",
        "Use alice+math@example.org and https://example.org/*keep*/1/4.",
        "Use a path https://example.test/a[1/4 rather than changing it.",
        "A ribbon is 8 cm long and a bag is 3 kg.",
        "Explain (why this works). Keep [A] and [B] as labels.",
        "第一段。\n第二段：请保留题目中的全部文字。",
    ],
)
def test_prose_identifiers_dates_paths_and_urls_are_not_reinterpreted(question, locale):
    assert prepare_task_speech(question, locale).text == question


def test_protected_dates_and_paths_do_not_disable_neighboring_arithmetic():
    question = "日期2026/11/14。文件data/1/4。计算8+8，比较1/4与1/6。"
    assert prepare_task_speech(question, "zh").text == (
        "日期2026/11/14。文件data/1/4。计算8 加 8，比较4分之1与6分之1。"
    )


def test_escaped_currency_dollars_are_literal_prose_not_math_delimiters():
    assert prepare_task_speech(r"The price is \$5 and \$7. Calculate 8+8.", "en").text == (
        "The price is $5 and $7. Calculate 8 plus 8."
    )


def test_markdown_unwraps_visible_content_without_speaking_hidden_link_target():
    question = "# **Question**\nRead [this *prompt*](https://example.test/1/4), then calculate 8+8."
    assert prepare_task_speech(question, "en").text == (
        "Question\nRead this prompt, then calculate 8 plus 8."
    )


def test_asterisk_emphasis_does_not_swallow_multiplication():
    assert prepare_task_speech("Compute 2*3*4 and **8*8**.", "en").text == (
        "Compute 2 times 3 times 4 and 8 times 8."
    )


def test_emphasis_can_enclose_a_protected_url():
    question = "**Read https://example.test/1/4 carefully**."
    assert prepare_task_speech(question, "en").text == ("Read https://example.test/1/4 carefully.")


@pytest.mark.parametrize(
    "question",
    [
        r"$\sqrt{4}$",
        r"$\sum_{i=1}^{5} i$",
        r"$\begin{matrix}1&2\\3&4\end{matrix}$",
        r"$\unknown{8}+8$",
        r"$\phantom{hidden}8+8$",
        r"$\frac12$",
        r"$\frac{1}{}$",
        r"$\frac{1}{2$",
        r"$x_1+2$",
        r"$x^{1+1}$",
        r"$2^4$",
        r"$2(x+1)$",
        r"$\left\{1,2\right\}$",
        r"$\text{hidden instructions}+1$",
        r"$*x*$",
        r"$_1+2_$",
        r"$[x](y)$",
        "计算 √4 + 1。",
        "计算 ½+1。",
        "计算 α+1。",
        "8+",
        "8+8，随后计算2**3。",
        "计算 sin(x) + 1。",
        "Calculate sqrt (4).",
        "What is f(x)?",
    ],
)
def test_unsupported_or_incomplete_math_refuses_the_whole_question(question):
    with pytest.raises(TaskSpeechUnsupported) as caught:
        prepare_task_speech(question, "zh")
    assert caught.value.reason == "unsupported_math"
    assert str(caught.value) == "unsupported_math"


@pytest.mark.parametrize(
    "question",
    [
        "计算8+8，再看 `x=1`。",
        "```python\nprint(8+8)\n```",
        "~~~python\nprint(8+8)\n~~~",
        "Read this code:\n    print(8+8)",
        "| A | B |\n| --- | --- |\n| 1 | 2 |",
        "计算8+8，再看 ![必要图形](https://example.test/triangle.png)。",
        '<img src="triangle.png" alt="必要图形">',
        "<b>Important</b>: calculate 8+8.",
        "8 &lt; 9",
        "计算 🍎+🍎。",
        "See diagram:\n- essential label",
    ],
)
def test_code_tables_images_and_html_are_never_silently_removed(question):
    with pytest.raises(TaskSpeechUnsupported) as caught:
        prepare_task_speech(question, "en")
    assert caught.value.reason == "unsupported_content"


@pytest.mark.parametrize(
    "question", ["$8+8", r"\(8+8", "[visible](https://example.test", "[visible]( )"]
)
def test_malformed_markup_is_explicitly_unavailable(question):
    with pytest.raises(TaskSpeechUnsupported) as caught:
        prepare_task_speech(question, "en")
    assert caught.value.reason == "malformed_markup"


def test_group_depth_is_bounded_without_rewriting_away_outer_groups():
    supported = "$" + "(" * 12 + "1+2" + ")" * 12 + "$"
    speech = prepare_task_speech(supported, "en").text
    assert speech.count("open parenthesis") == 12
    assert speech.count("close parenthesis") == 12
    with pytest.raises(TaskSpeechUnsupported, match="unsupported_math"):
        prepare_task_speech("$" + "(" * 13 + "1+2" + ")" * 13 + "$", "en")


def test_nested_tex_braces_are_bounded():
    within = r"$\frac{" + "{" * 11 + "1+2" + "}" * 11 + "}{3}$"
    assert "1 plus 2" in prepare_task_speech(within, "en").text
    beyond = r"$\frac{" + "{" * 12 + "1+2" + "}" * 12 + "}{3}$"
    with pytest.raises(TaskSpeechUnsupported, match="unsupported_math"):
        prepare_task_speech(beyond, "en")


def test_raw_and_spoken_limits_never_truncate():
    assert prepare_task_speech("a" * MAX_RAW_CHARS, "en").text == "a" * MAX_RAW_CHARS
    with pytest.raises(TaskSpeechUnsupported, match="too_long"):
        prepare_task_speech("a" * (MAX_RAW_CHARS + 1), "en")
    short_source_long_speech = "8+8 " * 1200
    assert len(short_source_long_speech) < MAX_RAW_CHARS
    with pytest.raises(TaskSpeechUnsupported, match="too_long"):
        prepare_task_speech(short_source_long_speech, "en")
    # Expression length must not become recursive depth through left nesting.
    with pytest.raises(TaskSpeechUnsupported, match="too_long"):
        prepare_task_speech("$" + "1+" * 2000 + "1$", "en")
    assert MAX_SPOKEN_CHARS == 6000


@pytest.mark.parametrize("question", [None, b"8+8", 16, ["8+8"]])
def test_only_actual_question_strings_are_accepted(question):
    with pytest.raises(TaskSpeechUnsupported, match="invalid_input"):
        prepare_task_speech(question, "en")


@pytest.mark.parametrize("locale", [None, "", "fr", "zh-CN", "en-US", [], {}])
def test_locale_is_explicitly_bounded(locale):
    with pytest.raises(TaskSpeechUnsupported, match="invalid_locale"):
        prepare_task_speech("8+8", locale)


@pytest.mark.parametrize("question", ["bad\ud800text", "bad\udffftext", "bad\ufffdtext"])
def test_invalid_or_replacement_unicode_does_not_sound_successful(question):
    with pytest.raises(TaskSpeechUnsupported, match="invalid_unicode"):
        prepare_task_speech(question, "en")


@pytest.mark.parametrize("question", ["\x00hidden", "a\u202eb", "a\ue000b"])
def test_invisible_control_or_private_glyphs_are_not_omitted(question):
    with pytest.raises(TaskSpeechUnsupported, match="unsupported_content"):
        prepare_task_speech(question, "en")


@pytest.mark.parametrize("question", ["", "  ", "\t\n"])
def test_empty_questions_have_a_stable_reason(question):
    with pytest.raises(TaskSpeechUnsupported, match="no_text"):
        prepare_task_speech(question, "en")
