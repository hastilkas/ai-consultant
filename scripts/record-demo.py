"""Запись демо-видео: настоящий диалог с ботом на развёрнутом сайте.

Запуск: price-monitor-bot/.venv/Scripts/python ai-consultant/scripts/record-demo.py [адрес сайта]
Видео (.webm) появится в ai-consultant/docs/raw/, дальше его пережимает ffmpeg (см. README портфолио).
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

SITE = sys.argv[1] if len(sys.argv) > 1 else "https://ai-consultant-one.vercel.app"
OUT = Path(__file__).resolve().parent.parent / "docs" / "raw"
SIZE = {"width": 1280, "height": 800}

DIALOG = [
    "Привет, я Илья. Варю в турке, люблю без кислинки",
    "Положите Бразилию, 2 пачки",
    "Оформляем: самовывоз, телефон 8 916 123-45-67",
    "Да",
]


def wait_reply(page):
    page.wait_for_function("!document.getElementById('send').disabled", timeout=90_000)
    time.sleep(2.2)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=SIZE, record_video_dir=str(OUT), record_video_size=SIZE, locale="ru-RU")
        page = ctx.new_page()
        page.goto(SITE, wait_until="networkidle")
        # Чат и панель «Под капотом» целиком в кадре
        page.evaluate("window.scrollTo(0, document.querySelector('.stage').offsetTop - 16)")
        time.sleep(1.5)

        for text in DIALOG:
            page.click("#input")
            page.keyboard.type(text, delay=38)
            time.sleep(0.4)
            page.keyboard.press("Enter")
            wait_reply(page)
            if text == "Да":
                # Показываем сообщение менеджеру: чат липкий и остаётся на месте
                page.evaluate("document.getElementById('owner-panel').scrollIntoView({behavior: 'smooth', block: 'end'})")
                time.sleep(4)
                page.evaluate("window.scrollTo({top: document.querySelector('.stage').offsetTop - 16, behavior: 'smooth'})")
                time.sleep(1.5)

        page.click("#revisit")
        time.sleep(4)
        path = page.video.path()
        ctx.close()
        browser.close()
        print(path)


if __name__ == "__main__":
    main()
