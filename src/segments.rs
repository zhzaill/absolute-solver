//! Text segmentation for segmented TTS turns.
//!
//! The splitter is a pure function: it never calls a provider and never reads
//! environment state. Boundaries follow `docs/TTS_REQUIREMENTS.md` §9.1:
//! strong sentence endings first, weak pause marks only past the soft budget,
//! and a hard character cap as the last resort. Cuts never fall inside an ASCII
//! word, a number, a URL, or an inline-code span.

pub const DEFAULT_SOFT_CHARS: usize = 24;
pub const DEFAULT_HARD_CHARS: usize = 48;
pub const DEFAULT_MIN_CHARS: usize = 6;

const STRONG_MARKS: [char; 8] = ['。', '！', '？', '!', '?', '；', ';', '\n'];
const WEAK_MARKS: [char; 5] = ['，', ',', '、', '：', ':'];
/// Characters that close a quoted or bracketed clause; a cut moves past them.
const TRAILING_MARKS: [char; 12] = [
    '”', '’', '」', '』', '）', ')', '】', ']', '》', '〉', '"', '\'',
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentLimits {
    pub soft_chars: usize,
    pub hard_chars: usize,
    pub min_chars: usize,
}

impl Default for SegmentLimits {
    fn default() -> Self {
        Self {
            soft_chars: DEFAULT_SOFT_CHARS,
            hard_chars: DEFAULT_HARD_CHARS,
            min_chars: DEFAULT_MIN_CHARS,
        }
    }
}

impl SegmentLimits {
    pub fn new(soft_chars: usize, hard_chars: usize) -> Self {
        let hard = hard_chars.max(8);
        Self {
            soft_chars: soft_chars.clamp(1, hard),
            hard_chars: hard,
            min_chars: DEFAULT_MIN_CHARS.min(hard / 2),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub index: usize,
    pub text: String,
}

impl Segment {
    pub fn chars(&self) -> usize {
        self.text.chars().count()
    }
}

/// Splits `text` into ordered speech segments.
pub fn split_for_tts(text: &str, limits: SegmentLimits) -> Vec<Segment> {
    let chars: Vec<char> = text.trim().chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let protected = protected_spans(&chars);
    let mut pieces: Vec<String> = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        if chars[start].is_whitespace() {
            start += 1;
            continue;
        }
        let hard_end = (start + limits.hard_chars).min(chars.len());
        let cut = find_cut(&chars, &protected, start, hard_end, limits);
        let piece: String = chars[start..cut].iter().collect();
        pieces.push(piece);
        start = cut;
    }
    normalize(pieces, limits)
}

fn protected_spans(chars: &[char]) -> Vec<bool> {
    let mut protected = vec![false; chars.len()];
    let mut in_code = false;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '`' {
            let end = chars[index + 1..]
                .iter()
                .position(|candidate| *candidate == '`')
                .map(|offset| index + 1 + offset);
            let stop = end.unwrap_or(chars.len() - 1);
            for slot in protected.iter_mut().take(stop + 1).skip(index) {
                *slot = true;
            }
            in_code = false;
            index = stop + 1;
            continue;
        }
        if is_word_char(ch) && !in_code {
            let mut stop = index;
            while stop < chars.len() && is_word_char(chars[stop]) {
                stop += 1;
            }
            // A single ASCII letter ("a", "x") is not worth protecting.
            if stop - index >= 2 {
                for slot in protected.iter_mut().take(stop).skip(index) {
                    *slot = true;
                }
            }
            index = stop;
            continue;
        }
        index += 1;
    }
    protected
}

fn is_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            '.' | '_' | '/' | ':' | '@' | '#' | '%' | '-' | '+' | '=' | '~' | '&' | '?'
        )
}

fn cut_allowed(protected: &[bool], position: usize) -> bool {
    if position == 0 || position >= protected.len() {
        return position == protected.len();
    }
    !(protected[position - 1] && protected[position])
}

fn find_cut(
    chars: &[char],
    protected: &[bool],
    start: usize,
    hard_end: usize,
    limits: SegmentLimits,
) -> usize {
    // 1. Strong sentence ending inside the hard budget.
    if let Some(cut) = strong_cut(chars, protected, start, hard_end) {
        return cut;
    }
    // 2. Weak pause mark past the soft budget, then any weak mark.
    let soft_end = (start + limits.soft_chars).min(hard_end);
    if let Some(cut) = weak_cut(chars, protected, soft_end, hard_end) {
        return cut;
    }
    if let Some(cut) = weak_cut(chars, protected, start + 1, hard_end) {
        return cut;
    }
    // 3. Hard cap, moved back to the last allowed position.
    if hard_end >= chars.len() {
        return chars.len();
    }
    for position in (start + 1..=hard_end).rev() {
        if cut_allowed(protected, position) {
            return position;
        }
    }
    // One protected run (a URL, a long number, inline code) is wider than the
    // whole budget: keep it intact and let this one segment exceed the cap.
    for position in hard_end + 1..chars.len() {
        if cut_allowed(protected, position) {
            return position;
        }
    }
    chars.len()
}

fn strong_cut(chars: &[char], protected: &[bool], start: usize, hard_end: usize) -> Option<usize> {
    let mut position = start;
    while position < hard_end {
        if STRONG_MARKS.contains(&chars[position]) {
            let mut cut = position + 1;
            while cut < chars.len() && TRAILING_MARKS.contains(&chars[cut]) {
                cut += 1;
            }
            if cut_allowed(protected, cut) {
                return Some(cut.min(chars.len()));
            }
        }
        position += 1;
    }
    None
}

fn weak_cut(chars: &[char], protected: &[bool], start: usize, hard_end: usize) -> Option<usize> {
    let mut cut = None;
    for position in start..hard_end {
        if WEAK_MARKS.contains(&chars[position]) {
            let after = position + 1;
            if cut_allowed(protected, after) {
                cut = Some(after);
            }
        }
    }
    cut
}

fn normalize(pieces: Vec<String>, limits: SegmentLimits) -> Vec<Segment> {
    let mut kept: Vec<String> = Vec::new();
    for piece in pieces {
        let trimmed = piece.trim();
        if trimmed.is_empty() || is_punctuation_only(trimmed) {
            continue;
        }
        kept.push(trimmed.to_owned());
    }
    // Merge fragments shorter than the minimum into a neighbour so the provider
    // never receives one- or two-character requests.
    let mut merged: Vec<String> = Vec::new();
    for piece in kept {
        if let Some(last) = merged.last_mut() {
            let combined = last.chars().count() + piece.chars().count();
            if last.chars().count() < limits.min_chars && combined <= limits.hard_chars {
                last.push_str(&piece);
                continue;
            }
        }
        merged.push(piece);
    }
    if merged.len() > 1 {
        if let Some(last) = merged.last().cloned() {
            if last.chars().count() < limits.min_chars {
                merged.pop();
                if let Some(previous) = merged.last_mut() {
                    if previous.chars().count() + last.chars().count() <= limits.hard_chars * 2 {
                        previous.push_str(&last);
                    } else {
                        merged.push(last);
                    }
                } else {
                    merged.push(last);
                }
            }
        }
    }
    merged
        .into_iter()
        .enumerate()
        .map(|(index, text)| Segment { index, text })
        .collect()
}

fn is_punctuation_only(text: &str) -> bool {
    text.chars().all(|ch| {
        ch.is_whitespace()
            || STRONG_MARKS.contains(&ch)
            || WEAK_MARKS.contains(&ch)
            || TRAILING_MARKS.contains(&ch)
            || matches!(
                ch,
                '。' | '、' | '…' | '—' | '~' | '～' | '-' | '「' | '『' | '（'
            )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STORY: &str =
        "夜里十一点，图书馆的灯还亮着。她把最后一册书放回架子，听见走廊尽头有脚步声。\
那声音很轻，却一直停在同一格。她合上登记簿，慢慢走过去，发现那里只有一面镜子。\
镜子里的人比她先笑了一下。她退后一步，镜面就安静下来，像什么都没发生。";

    #[test]
    fn story_splits_into_bounded_segments() {
        let segments = split_for_tts(STORY, SegmentLimits::default());
        assert!(segments.len() >= 3, "segments: {segments:?}");
        for segment in &segments {
            assert!(
                segment.chars() <= DEFAULT_HARD_CHARS,
                "too long: {segment:?}"
            );
            assert!(!segment.text.trim().is_empty());
        }
        assert_eq!(segments[0].index, 0);
        let rebuilt: String = segments
            .iter()
            .map(|segment| segment.text.clone())
            .collect::<Vec<_>>()
            .join("");
        assert!(rebuilt.chars().count() + 5 >= STORY.chars().count());
    }

    #[test]
    fn first_segment_ends_on_a_sentence_boundary() {
        let segments = split_for_tts(STORY, SegmentLimits::default());
        assert!(segments[0].text.ends_with('。'), "first: {segments:?}");
        assert!(segments[0].chars() <= DEFAULT_HARD_CHARS);
    }

    #[test]
    fn decimals_urls_and_code_are_never_cut() {
        let text = "版本 1.234.567 的补丁位于 https://example.com/a/b/c 这个地址，代码是 `let x = 1.5;` 请核对。";
        let segments = split_for_tts(text, SegmentLimits::new(12, 20));
        // Joining with a separator makes a cut inside a token visible: the token
        // would then appear as `1.234|.567` and the intact form would be missing.
        let joined = segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join("|");
        assert!(joined.contains("1.234.567"), "{segments:?}");
        assert!(joined.contains("https://example.com/a/b/c"), "{segments:?}");
        assert!(joined.contains("`let x = 1.5;`"), "{segments:?}");
        // The URL (25 chars) and the inline code span (14 chars) are wider than
        // the 20-char budget, so exactly those segments may exceed the cap
        // instead of being cut through the middle of a token.
        for segment in &segments {
            if segment.text.contains("https://") || segment.text.contains('`') {
                assert!(segment.chars() > 20, "{segment:?}");
            } else {
                assert!(segment.chars() <= 20, "{segment:?}");
            }
        }
    }

    #[test]
    fn ascii_words_stay_intact() {
        let text = "The quick brown fox jumps over the lazy dog. Then it keeps running through the quiet garden.";
        let segments = split_for_tts(text, SegmentLimits::new(8, 16));
        let joined = segments
            .iter()
            .map(|segment| segment.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(joined.contains("quick brown fox"), "{segments:?}");
        assert!(joined.contains("keeps running"), "{segments:?}");
        for segment in &segments {
            assert!(segment.chars() <= 16, "{segment:?}");
            let trimmed = segment.text.trim();
            assert_eq!(trimmed, segment.text);
            assert!(!trimmed.is_empty());
        }
    }

    #[test]
    fn short_fragments_are_merged_and_punctuation_is_dropped() {
        let segments = split_for_tts(
            "好。行。走吧，我们去看看那个地方。",
            SegmentLimits::default(),
        );
        assert!(!segments.is_empty());
        assert!(segments[0].chars() >= DEFAULT_MIN_CHARS, "{segments:?}");
        let only_marks = split_for_tts("。。。，，，", SegmentLimits::default());
        assert!(only_marks.is_empty());
    }

    #[test]
    fn long_text_without_punctuation_is_hard_capped() {
        let text = "这".repeat(120);
        let segments = split_for_tts(&text, SegmentLimits::default());
        assert_eq!(segments.len(), 3);
        for segment in &segments {
            assert!(segment.chars() <= DEFAULT_HARD_CHARS);
        }
    }

    #[test]
    fn empty_and_whitespace_input_yield_no_segments() {
        assert!(split_for_tts("", SegmentLimits::default()).is_empty());
        assert!(split_for_tts("   \n\t ", SegmentLimits::default()).is_empty());
    }
}
