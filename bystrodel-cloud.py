#!/usr/bin/env python3
"""Мост Быстродела: Obsidian на маке ↔ Supabase.

Выгружает заметки (служебные строки + шаги) в bd_notes и применяет
правки из Mini App (bd_changes) обратно в заметки. Главное — Obsidian:
если заметка изменилась позже правки, правка не применяется.

Вход берётся из сессии моста VibeBar — тот же проект и тот же аккаунт.
"""

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

SUPA_URL = "https://yqumtlykftuxswbhnfru.supabase.co"
SUPA_KEY = "sb_publishable_swH79jNgc-iQc04BGmSldw_3n9na-Uy"
SESSION = Path.home() / ".vibebar/.cloud/session.json"     # общая с VibeBar
HOME = Path.home() / ".bystrodel"
STATE = HOME / "state.json"
HEALTH = HOME / "health.json"
VAULT = Path.home() / "Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian"
ZONE = VAULT / "Claude"

# какие папки показываем в приложении и какой тип ставим, если строк нет
TRASH = VAULT / "Claude" / "Корзина"
BOARD = VAULT / "Kanban задач" / "Kanban задач.md"
DONE_COLUMN = {"сделано": "## ✅ Готово", "изучено": "## 📚 Полезные статьи"}


def board_move(name, column):
    """Двигаем карточку заметки по доске: в колонку с галочкой или прочь (column=None).
    Карточки нет — доску не трогаем: новые карточки ставит бот, а не мост."""
    if not BOARD.exists():
        return False
    text = BOARD.read_text(encoding="utf-8")
    marks = (f"[[{name}|", f"[[{name}]]")
    card, rows = None, []
    for line in text.split("\n"):
        if line.lstrip().startswith("- [") and any(m in line for m in marks):
            card = card or line.strip()
            continue
        rows.append(line)
    if card is None:
        return False
    if column:
        card = re.sub(r"^- \[ \]", "- [x]", card)
        for i, line in enumerate(rows):
            if line.strip() == column:
                at = i + 1 + (1 if i + 1 < len(rows) and not rows[i + 1].strip() else 0)
                rows.insert(at, card)
                break
        else:
            return False
    new = re.sub(r"\n{3,}", "\n\n", "\n".join(rows))
    if new != text:
        BOARD.write_text(new, encoding="utf-8")
        log("доска:", name, "→", column or "убрана")
    return True

FOLDERS = {
    "Бизнес/Задачи на внедрение": "задача",
    "Бизнес/Идеи по бизнесу": "идея",
    "Бизнес/Гипотезы проектов": "гипотеза",
    "Бизнес/Разобрать": "разобрать",
    "Не забыть": "не забыть",
    "Цели (Бизнес)": "цель",
    "WIKI (База)/Полезные материалы": "материал",
    "WIKI (База)/Изучить информацию": "материал",
    "WIKI (База)/Статьи": "материал",
    "Контент/Идеи": "контент",
    "Контент/Сценарии": "контент",
}
SKIP_NAMES = {"Задачи на внедрение", "Идеи по бизнесу", "Гипотезы проектов", "Разобрать",
              "Цели (Бизнес)", "Контент", "Не забыть"}   # заметки-оглавления папок


def log(*parts):
    print(datetime.now().strftime("%H:%M:%S"), *parts, flush=True)


# ---------- доступ ----------

def session():
    """Свежий access_token. Протух — обновляем и кладём обратно в общий файл."""
    data = json.loads(SESSION.read_text())
    if data.get("expires_at", 0) - time.time() > 60:
        return data["access_token"]
    body = json.dumps({"refresh_token": data["refresh_token"]}).encode()
    req = urllib.request.Request(
        f"{SUPA_URL}/auth/v1/token?grant_type=refresh_token", body,
        {"apikey": SUPA_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        fresh = json.loads(r.read())
    data.update(access_token=fresh["access_token"], refresh_token=fresh["refresh_token"],
                expires_at=int(time.time()) + int(fresh.get("expires_in", 3600)))
    tmp = SESSION.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(SESSION)          # атомарно: VibeBar читает тот же файл
    return data["access_token"]


def api(method, path, payload=None, token=None, prefer=None):
    token = token or session()
    body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    headers = {"apikey": SUPA_KEY, "Authorization": f"Bearer {token}",
               "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(f"{SUPA_URL}/rest/v1/{path}", body, headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            raw = r.read()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{e.code} {e.read().decode()[:200]}")


# ---------- заметки ----------

def parse(path):
    """Служебные строки, шаги и начало текста одной заметки."""
    text = path.read_text(encoding="utf-8", errors="replace")
    meta, body = {}, text
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end > 0:
            for line in text[4:end].split("\n"):
                if ":" in line:
                    k, v = line.split(":", 1)
                    meta[k.strip()] = v.strip()
            body = text[end + 4:].lstrip("\n")
    steps = []
    block = re.search(r"^##\s*Шаги\s*$(.*?)(^##\s|\Z)", body, re.M | re.S)
    if block:
        for m in re.finditer(r"^- \[( |x|X)\]\s*(.+)$", block.group(1), re.M):
            steps.append({"t": m.group(2).strip(), "done": m.group(1).lower() == "x", "basket": False})
    text_only = re.sub(r"^##\s*Шаги\s*$.*?(?=^##\s|\Z)", "", body, flags=re.M | re.S)
    text_only = re.sub(r"^#+\s*$", "", text_only, flags=re.M)
    lines = [" ".join(line.split()) for line in text_only.split("\n")]
    excerpt = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()[:1500]
    return meta, steps, excerpt


def rows():
    out = []
    for folder, default_kind in FOLDERS.items():
        base = ZONE / folder
        if not base.exists():
            continue
        for path in sorted(base.glob("*.md")):
            if path.stem in SKIP_NAMES:
                continue
            meta, steps, excerpt = parse(path)
            rel = str(path.relative_to(VAULT))
            quick = meta.get("быстрое", "нет").lower() == "да"
            try:
                minutes = int(re.sub(r"\D", "", meta.get("минуты", "")) or (5 if quick else 15))
            except ValueError:
                minutes = 5
            out.append({
                "id": hashlib.sha1(rel.encode()).hexdigest()[:20],
                "path": rel,
                "title": path.stem,
                "folder": folder,
                "kind": meta.get("тип", default_kind),
                "status": meta.get("статус", "новое"),
                "quick": quick,
                "minutes": minutes,
                "decided": meta.get("решил", "агент"),
                "source": meta.get("источник", "текст"),
                "steps": steps,
                "starts": int(re.sub(r"\D", "", meta.get("подходы", "")) or 0),
                "excerpt": excerpt,
                "note_mtime": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
                "deleted": False,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
    return out


def push(token):
    """Отправляем только изменившиеся заметки."""
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    seen, changed = {}, []
    for row in rows():
        same = {k: v for k, v in row.items() if k != "updated_at"}
        stamp = hashlib.sha1(json.dumps(same, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]
        seen[row["id"]] = stamp
        if state.get("notes", {}).get(row["id"]) != stamp:
            changed.append(row)
    known = state.get("notes", {})
    gone = [i for i in known if i not in seen]
    # Защита: пропали все заметки или больше половины — это не удаление,
    # а сбой доступа к хранилищу. Ничего не стираем, поднимаем тревогу.
    trashed = set(state.get("trashed", []))
    lost = [i for i in gone if i not in trashed]
    if known and (not seen or len(lost) > len(known) / 2):
        HEALTH.write_text(json.dumps({"err": f"хранилище отдало {len(seen)} заметок вместо {len(known)} — облако не трогаю",
                                      "err_at": int(time.time())}, ensure_ascii=False))
        log(f"стоп: видно {len(seen)} заметок вместо {len(known)}")
        return 0, 0
    if changed:
        api("POST", "bd_notes", changed, token, prefer="resolution=merge-duplicates")
    for note_id in gone:                      # заметку удалили или переименовали
        api("PATCH", f"bd_notes?id=eq.{note_id}", {"deleted": True}, token)
    state["notes"] = seen
    state["trashed"] = sorted(trashed - set(gone))
    STATE.write_text(json.dumps(state, ensure_ascii=False))
    return len(changed), len(gone)


# ---------- правки из приложения ----------

def set_meta(text, key, value):
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        head, rest = text[4:end], text[end:]
        if re.search(rf"^{key}:", head, re.M):
            head = re.sub(rf"^{key}:.*$", f"{key}: {value}", head, count=1, flags=re.M)
        else:
            head = head.rstrip("\n") + f"\n{key}: {value}"
        return "---\n" + head + rest
    return f"---\n{key}: {value}\n---\n\n" + text


def set_step(text, index, done):
    marks = list(re.finditer(r"^- \[( |x|X)\]\s*(.+)$", text, re.M))
    if index >= len(marks):
        raise RuntimeError("шага с таким номером нет")
    m = marks[index]
    return text[:m.start()] + f"- [{'x' if done else ' '}] {m.group(2)}" + text[m.end():]


def apply(token):
    pending = api("GET", "bd_changes?applied_at=is.null&order=created_at&limit=50", token=token)
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    mine = state.get("written", {})          # что мост писал сам — это не чужое вмешательство
    trashed = set(state.get("trashed", []))  # удалено из приложения — не сбой доступа
    done = 0
    for change in pending:
        note = api("GET", f"bd_notes?id=eq.{change['note_id']}&select=path", token=token)
        result = {"applied_at": datetime.now(timezone.utc).isoformat(), "error": None}
        try:
            if not note:
                raise RuntimeError("заметка не найдена")
            if change["op"] == "basket":            # корзина живёт только в облаке, файл не трогаем
                api("PATCH", f"bd_notes?id=eq.{change['note_id']}",
                    {"basket": bool(change["value"]["basket"]), "basket_day": date.today().isoformat()}, token)
                api("PATCH", f"bd_changes?id=eq.{change['id']}", result, token)
                done += 1
                continue
            path = VAULT / note[0]["path"]
            if not path.exists():
                raise RuntimeError("файла нет на диске")
            if change["op"] == "trash":             # не стираем: переносим в «Claude/Корзина», путь сохраняем
                rel = Path(note[0]["path"])
                inner = rel.relative_to("Claude") if rel.parts[0] == "Claude" else rel
                target = TRASH / inner
                target.parent.mkdir(parents=True, exist_ok=True)
                n = 2
                while target.exists():
                    target = TRASH / inner.parent / f"{inner.stem} ({n}){inner.suffix}"
                    n += 1
                path.rename(target)
                board_move(rel.stem, None)
                trashed.add(change["note_id"])
                log("в корзину:", note[0]["path"], "→", str(target.relative_to(VAULT)))
                api("PATCH", f"bd_changes?id=eq.{change['id']}", result, token)
                done += 1
                continue
            made = datetime.fromisoformat(change["created_at"].split("+")[0][:19])
            edge = max(made.replace(tzinfo=timezone.utc).timestamp(), mine.get(change["note_id"], 0))
            if path.stat().st_mtime > edge + 2:
                raise RuntimeError("конфликт: заметку меняли в Obsidian позже")
            text = path.read_text(encoding="utf-8")
            op, value = change["op"], change["value"]
            if op == "status":
                text = set_meta(text, "статус", value["status"])
            elif op == "quick":
                text = set_meta(text, "быстрое", "да" if value["quick"] else "нет")
            elif op == "minutes":
                text = set_meta(text, "минуты", int(value["minutes"]))
            elif op == "start":
                text = set_meta(text, "подходы", int(value.get("starts", 0)))
            elif op == "step":
                text = set_step(text, int(value["index"]), bool(value["done"]))
            else:
                raise RuntimeError(f"неизвестная правка {op}")
            path.write_text(text, encoding="utf-8")
            mine[change["note_id"]] = path.stat().st_mtime
            if op == "status" and value.get("status") in DONE_COLUMN:
                board_move(path.stem, DONE_COLUMN[value["status"]])
            done += 1
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            log("нет связи, правка подождёт:", str(exc)[:120])
            continue
        except Exception as exc:
            result["error"] = str(exc)[:200]
            log("правка не применилась:", result["error"])
        api("PATCH", f"bd_changes?id=eq.{change['id']}", result, token)
    state["written"] = mine
    state["trashed"] = sorted(trashed)
    STATE.write_text(json.dumps(state, ensure_ascii=False))
    return done, len(pending) - done


def clear_basket(token):
    """Корзина живёт день: всё, что взято не сегодня, вычищаем."""
    today = date.today().isoformat()
    api("PATCH", f"bd_notes?basket=is.true&or=(basket_day.is.null,basket_day.lt.{today})",
        {"basket": False}, token)


def once():
    HOME.mkdir(exist_ok=True)
    token = session()
    sent, gone = push(token)
    applied, failed = apply(token)
    if applied:                               # записали в заметки — сразу отдаём облаку, не ждём круга
        more, more_gone = push(token)
        sent, gone = sent + more, gone + more_gone
    clear_basket(token)
    HEALTH.write_text(json.dumps({"ok_at": int(time.time()), "sent": sent,
                                  "gone": gone, "applied": applied, "failed": failed, "seen": len(json.loads(STATE.read_text()).get("notes", {})) if STATE.exists() else 0}))
    return sent, gone, applied, failed


def main():
    if "--once" in sys.argv:
        log("итог:", once())
        return
    while True:
        try:
            sent, gone, applied, failed = once()
            if sent or gone or applied or failed:
                log(f"выгружено {sent}, скрыто {gone}, применено {applied}, с ошибкой {failed}")
        except Exception as exc:
            log("сбой:", str(exc)[:200])
            HEALTH.write_text(json.dumps({"err": str(exc)[:200], "err_at": int(time.time())}))
        time.sleep(60)


if __name__ == "__main__":
    main()
