#!/usr/bin/env python3
"""
从 ECDICT (https://github.com/skywind3000/ECDICT, MIT) 构建精读 LexiRead 用的精简离线词典。

用法:
    python3 scripts/build_dict.py build/ecdict.csv data/dict.json

输出格式（尽量小、解析快）:
    {"v":1,"n":<条数>,"src":"ECDICT","recs":"word\t音标\t中文释义\t词频\t柯林斯\t牛津\ttags\n..."}
"""
import csv, json, os, re, sys

WORD_RE = re.compile(r"^[a-z][a-z'’\-]*$")
MAX_LEN = 24
RANK_LIMIT = 30000          # 保留 COCA/BNC 词频前 N
HARD_CAP = 46000            # 总条数上限


def clean_zh(s: str) -> str:
    s = s.replace("\\n", "；").replace("\r", " ").replace("\n", "；")
    # 去掉 [网络] 之类的噪声段（前面还有正经释义时）
    for marker in ("[网络]", "[俚语]", "[医]", "[计]", "[经]", "[化]", "[物]", "[数]", "[法]", "[军]", "[机]", "[电]", "[冶]", "[纺]", "[农]", "[建]", "[无]"):
        i = s.find(marker)
        if i > 12:
            s = s[:i]
            break
    s = re.sub(r"[；;]\s*[；;]+", "；", s)
    s = s.replace("\t", " ").strip("；; ")
    return s.strip()


def main():
    src, dst = sys.argv[1], sys.argv[2]
    rows = []
    seen = set()

    with open(src, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            w = (row.get("word") or "").strip()
            if not w or len(w) > MAX_LEN or w in seen:
                continue
            lw = w.lower()
            if not WORD_RE.match(lw):
                continue
            zh = clean_zh(row.get("translation") or "")
            if len(zh) < 2:
                continue

            def num(v):
                try:
                    return int(v)
                except Exception:
                    return 0

            frq, bnc = num(row.get("frq")), num(row.get("bnc"))
            collins, oxford = num(row.get("collins")), num(row.get("oxford"))
            tags = " ".join((row.get("tag") or "").split())
            rank = min([x for x in (frq, bnc) if x > 0] or [10 ** 9])

            keep = (rank <= RANK_LIMIT) or oxford == 1 or collins >= 2 or bool(tags)
            if not keep:
                continue
            seen.add(w)
            rows.append((rank, lw, (row.get("phonetic") or "").strip(),
                         zh, frq, collins, oxford, tags))

    rows.sort(key=lambda r: (r[0], len(r[1])))
    if len(rows) > HARD_CAP:
        rows = rows[:HARD_CAP]

    recs = []
    for rank, w, phon, zh, frq, collins, oxford, tags in rows:
        phone = phon.replace("\t", " ").replace("\n", " ").replace("；", " ").strip()
        recs.append("\t".join([w, phone, zh, str(frq), str(collins), str(oxford), tags]))

    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"v": 1, "n": len(recs), "src": "ECDICT (MIT)",
                   "recs": "\n".join(recs)}, f, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(dst)
    print(f"OK  {len(recs)} 条  →  {dst}  {size/1048576:.2f} MB")


if __name__ == "__main__":
    main()
