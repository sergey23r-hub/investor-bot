import logging
import os
import re
import json
import requests
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, ContextTypes, filters

# Твой токен бота
TOKEN = "7788458789:AAG7ZvMoMeS6zeeKHlhrK_vsAdH7jrZlFUQ"

# Логирование
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# Маппинг тикеров на CoinGecko ID
COINGECKO_IDS = {
    "btc": "bitcoin",
    "eth": "ethereum",
    "ada": "cardano",
    "bnb": "binancecoin",
    "xrp": "ripple",
    "doge": "dogecoin",
    "sol": "solana",
    "matic": "polygon",
    "dot": "polkadot",
    "link": "chainlink",
    "ltc": "litecoin",
    "wif": "dogwifhat",
    "pepe": "pepe"
}

# Директория хранения данных
DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)

# === Функции работы с данными ===

def get_user_file(user_id):
    return os.path.join(DATA_DIR, f"{user_id}.json")

def load_portfolio(user_id):
    file_path = get_user_file(user_id)
    if os.path.exists(file_path):
        with open(file_path, 'r') as f:
            return json.load(f)
    return {}

def save_portfolio(user_id, portfolio):
    file_path = get_user_file(user_id)
    with open(file_path, 'w') as f:
        json.dump(portfolio, f)

def get_price(symbol):
    coingecko_id = COINGECKO_IDS.get(symbol.lower())
    if not coingecko_id:
        return None
    try:
        response = requests.get(f"https://api.coingecko.com/api/v3/simple/price?ids={coingecko_id}&vs_currencies=usd")
        data = response.json()
        return data.get(coingecko_id, {}).get("usd")
    except:
        return None

# === Команды бота ===

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (
        "👋 Привет! Я — твой Дневник Инвестора.\n\n"
        "📥 Что я умею:\n"
        "— фиксировать покупки: «купил 0.3 BTC по 65000»\n"
        "— фиксировать продажи: «продал 1.2 ETH по 3200»\n"
        "— считать твой баланс: /balance\n"
        "— показывать прибыль и убыток: /pnl\n"
        "— выводить историю сделок: /history\n\n"
        "📊 Поддерживаются любые популярные крипто-токены.\n"
        "💾 Я всё запоминаю и не теряю данные между перезапусками.\n\n"
        "Готов? Погнали! 🚀"
    )
    await update.message.reply_text(text)

async def handle_transaction(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    text = update.message.text.lower()
    match = re.match(r"(купил|продал)\s+([\d.]+)\s+([a-zA-Z]+)\s*(?:по\s*\$?([\d.]+))?", text)

    if not match:
        await update.message.reply_text("Неверный формат. Используй: 'купил 0.5 BTC по 20000'")
        return

    action, amount, symbol, price = match.groups()
    amount = float(amount)
    symbol = symbol.upper()
    price = float(price) if price else get_price(symbol)

    if not price:
        await update.message.reply_text(f"Цена для {symbol} не найдена.")
        return

    portfolio = load_portfolio(user_id)
    history = portfolio.get("history", [])

    if symbol not in portfolio:
        portfolio[symbol] = {"amount": 0, "total_spent": 0.0}

    if action == "купил":
        portfolio[symbol]["amount"] += amount
        portfolio[symbol]["total_spent"] += amount * price
        history.append(f"{action} {amount} {symbol} по ${price}")
    elif action == "продал":
        if portfolio[symbol]["amount"] < amount:
            await update.message.reply_text(f"Недостаточно {symbol} для продажи.")
            return
        portfolio[symbol]["total_spent"] -= (portfolio[symbol]["total_spent"] / portfolio[symbol]["amount"]) * amount
        portfolio[symbol]["amount"] -= amount
        history.append(f"{action} {amount} {symbol} по ${price}")

    portfolio["history"] = history
    save_portfolio(user_id, portfolio)

    await update.message.reply_text(f"✅ {action.title()} {amount} {symbol} записано.")

async def balance(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    portfolio = load_portfolio(user_id)
    total_value = 0
    text = "💼 Твой портфель:\n"
    for symbol, data in portfolio.items():
        if symbol == "history":
            continue
        price = get_price(symbol)
        value = data["amount"] * price if price else 0
        total_value += value
        text += f"{data['amount']} {symbol} = ${value:.2f}\n" if price else f"{data['amount']} {symbol} = (цена не найдена)\n"
    text += f"\nОбщий баланс: ${total_value:.2f}"
    await update.message.reply_text(text)

async def pnl(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    portfolio = load_portfolio(user_id)
    total_pnl = 0
    text = "📊 Прибыль/Убыток:\n"
    for symbol, data in portfolio.items():
        if symbol == "history":
            continue
        price = get_price(symbol)
        if not price:
            text += f"{symbol}: (цена не найдена)\n"
            continue
        current_value = data["amount"] * price
        pnl = current_value - data["total_spent"]
        total_pnl += pnl
        text += f"{symbol}: ${pnl:.2f}\n"
    text += f"\nИтого по портфелю: ${total_pnl:.2f}"
    await update.message.reply_text(text)

async def history(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.message.from_user.id
    portfolio = load_portfolio(user_id)
    history = portfolio.get("history", [])
    if not history:
        await update.message.reply_text("История пуста.")
    else:
        text = "🕓 История транзакций:\n" + "\n".join(history[-10:])
        await update.message.reply_text(text)

# Запуск
app = ApplicationBuilder().token(TOKEN).build()
app.add_handler(CommandHandler("start", start))
app.add_handler(CommandHandler("balance", balance))
app.add_handler(CommandHandler("pnl", pnl))
app.add_handler(CommandHandler("history", history))
app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_transaction))
app.run_polling()
