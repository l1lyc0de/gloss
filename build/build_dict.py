#!/usr/bin/env python3
"""把 ECDICT 完整库切成按首两字母分片的离线词典。

用法：
    python3 gloss/build/build_dict.py [--src data/stardict.db] [--out gloss/public/dict]

为什么要分片：完整词典是几十 MB 的 JSON，手机上 JSON.parse 会卡死甚至崩掉。
切成几百个几十 KB 的分片后，查词只加载对应那一片（`ab.json`、`ac.json`…），
查过的常驻内存，「点一下秒出」这个核心体验才保得住。

关于品牌标签：ECDICT 里的 `collins` / `oxford` 是柯林斯星级和牛津核心词标记，
那是别人的商标和编纂成果。这里只把 collins 的数值当作中性的「常用度」保留
（字段名 s），oxford 整个丢掉，前端也只显示 ★ 不出现任何品牌名。
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

# 只收单词条目：正文分词用的是 [A-Za-z]+(['-][A-Za-z]+)* 这个模式，
# 带空格的词组永远不会被点到，收进来纯属浪费体积。
WORD_RE = re.compile(r"^[A-Za-z]+(?:['\-][A-Za-z]+)*$")
MAX_WORD_LEN = 32
MAX_TRANS_LEN = 400
EXCHANGE_LEMMA_RE = re.compile(r"(?:^|/)0:([A-Za-z'\-]+)")

# 和前端 dict.js 里的 EASY_TAGS / KNOWN_RANK 保持一致
EASY_TAGS = re.compile(r"\b(zk|gk|cet4)\b")
KNOWN_RANK = 3000


def shard_key(word):
    """首两字母；不足两位或含非字母的补 '_'，保证分片名总是安全的文件名。"""
    w = (word.lower() + "__")[:2]
    return "".join(c if "a" <= c <= "z" else "_" for c in w)


def clean_translation(t):
    # ECDICT 里换行是真实换行，压成 \n 交给前端统一处理
    t = t.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(t) > MAX_TRANS_LEN:
        t = t[:MAX_TRANS_LEN].rstrip() + "…"
    return t


def build(src, out, keep_all):
    db = sqlite3.connect(src)
    db.row_factory = sqlite3.Row
    cur = db.execute(
        "SELECT word, phonetic, translation, tag, collins, frq, bnc, exchange "
        "FROM stardict WHERE translation IS NOT NULL AND translation <> ''"
    )

    shards = defaultdict(dict)
    easy = set()    # 判定为「简单词」的，第二遍拆词要用
    seen = 0
    kept = 0
    rejected = {}   # 被门槛滤掉但可能要救回来的：拼接词，见下面第二遍
    for r in cur:
        seen += 1
        w = r["word"]
        if not w or len(w) > MAX_WORD_LEN or not WORD_RE.match(w):
            continue
        key = w.lower()

        tag = (r["tag"] or "").strip()
        collins = r["collins"] or 0
        frq = r["frq"] or 0
        bnc = r["bnc"] or 0
        exch = r["exchange"] or ""

        # 收词门槛：有考纲标签 / 有常用度 / 有词频 / 有词形变化的都留（32 万词）。
        # 剩下 97 万条是既没人标注过、也没人统计过频次的东西，实测在整本书里
        # 只贡献 62 个词形，而且绝大多数是 father's / self-centered 这类
        # 所有格和连字符复合词 —— 前端本来就要拆开来查，收进来纯属三倍体积。
        if not keep_all and not (tag or collins or frq or bnc or exch):
            # 先记下来，第二遍再看要不要救。ECDICT 里 cannot 就是这么掉出去的：
            # 它有音标有释义，却既没考纲标签也没词频，三条门槛全都不占。
            if 6 <= len(key) <= 16 and key.isalpha():
                rejected[key] = r
            continue

        entry = {"t": clean_translation(r["translation"])}
        if r["phonetic"]:
            entry["p"] = r["phonetic"].strip()
        if tag:
            entry["g"] = tag
        if collins:
            entry["s"] = collins          # 中性「常用度」，不带任何品牌名
        if frq:
            entry["f"] = frq              # COCA 词频排名，越小越常见
        if bnc:
            entry["n"] = bnc              # BNC 词频排名
        m = EXCHANGE_LEMMA_RE.search(exch)
        if m:
            lemma = m.group(1).lower()
            if lemma != key:
                entry["x"] = lemma        # 原形；注意它可能是错的，见 dict.js 的并集修法

        # word 列是 UNIQUE COLLATE NOCASE，同一个 key 不会重复出现
        shards[shard_key(key)][key] = entry
        kept += 1
        # 「简单词」的判定必须和前端 dict.js 的 easyEntry 完全一致，
        # 否则救回来的词和前端会拆词的词对不上
        if EASY_TAGS.search(tag) or (0 < frq <= KNOWN_RANK) or (0 < bnc <= KNOWN_RANK):
            easy.add(key)

    # 第二遍：把「能拆成两个已收录的词」的拼接词救回来。
    #
    # 为什么值得单独走一遍：这类词前端本来就要靠拆词兜底才查得到，而拆出来的
    # 释义是拼的（cannot 会显示成「can：vt. 装罐 / not：…」，因为 ECDICT 的 can
    # 头一条义项是「装罐」）。ECDICT 明明有 cannot 自己的「aux. 无法, 不能」，
    # 收进来才是对的。规则本身是自洽的：**凡是我们不得不靠拼装来解释的词，
    # 就把它真正的词条收进来。**
    #
    # ⚠️ 两半都必须是**简单词**，判据和前端 dict.js 的 splitCompound 一模一样。
    # 只要求「两半都在词典里」是不行的：英文三字母词太多，几乎任何长词都能拆开，
    # 实测那样会救回 37.8 万条、体积从 26.6MB 涨到 46.7MB。
    #
    # 另外试过一个更宽的口子「有音标就收」，结果多出 14.7 万条 Laugiidae、
    # thioureido 这种生僻术语，体积涨四成、收益是零。
    rescued = 0
    for key, r in rejected.items():
        for i in range(3, len(key) - 2):
            a, b = key[:i], key[i:]
            if a in easy and b in easy:
                # e:1 = 「这是两个简单词拼起来的，算简单词」。
                # 在这里标出来，前端就不必为了判断难易再去多加载一个分片。
                e = {"t": clean_translation(r["translation"]), "e": 1}
                if r["phonetic"]:
                    e["p"] = r["phonetic"].strip()
                shards[shard_key(key)][key] = e
                kept += 1
                rescued += 1
                break

    os.makedirs(out, exist_ok=True)
    # 清掉上一次的分片，避免收词规则变严之后留下孤儿文件
    for f in os.listdir(out):
        if f.endswith(".json"):
            os.remove(os.path.join(out, f))

    manifest = {"version": 1, "shards": {}, "words": kept}
    total = 0
    for name in sorted(shards):
        path = os.path.join(out, name + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(shards[name], fh, ensure_ascii=False, separators=(",", ":"))
        size = os.path.getsize(path)
        total += size
        manifest["shards"][name] = {"n": len(shards[name]), "b": size}
    manifest["bytes"] = total

    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, separators=(",", ":"))

    print(f"扫描 {seen} 行 → 收录 {kept} 词（其中拼接词救回 {rescued} 条），{len(shards)} 个分片")
    print(f"总体积 {total/1048576:.1f} MB（gzip 后约为其 1/4）")
    biggest = sorted(manifest["shards"].items(), key=lambda kv: -kv[1]["b"])[:5]
    print("最大分片：" + "、".join(f"{k} {v['b']//1024}KB" for k, v in biggest))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(root, "data", "stardict.db"))
    ap.add_argument("--out", default=os.path.join(root, "gloss", "public", "dict"))
    ap.add_argument(
        "--full",
        action="store_true",
        help="连没有任何标注和词频的生僻词条一起收（129 万词 / 78MB，是默认的三倍）。"
             "默认的 32 万词已经覆盖实测整本书 99% 的词形。",
    )
    a = ap.parse_args()
    if not os.path.exists(a.src):
        sys.exit(f"找不到词典库 {a.src}")
    build(a.src, a.out, a.full)
