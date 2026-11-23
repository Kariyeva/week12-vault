# Задание 12 — обмен через Raydium из vault

Кариева Карина · AlmaU · Solana Devnet

Vault из задания 10 дополнен вторым токеновым хранилищем и подключён к пулу Raydium CLMM из задания 11. Обмен запускает администратор, а перевод токенов из хранилища подписывает PDA vault через CPI. Пока vault держит второй токен, депозиты и вывод заблокированы: расчёт долей учитывает только Mint A.

| Проверка | Результат |
|---|---|
| Депозит | Внесено 100 Mint A, комиссия 1 Mint A, в vault поступило 99 Mint A |
| Симуляция обмена | За 10 Mint A ожидается 9.970339 Mint B |
| Защита от проскальзывания | Минимум с допуском 1%: 9.870635 Mint B |
| Успешный обмен | В vault осталось 89 Mint A и поступило 9.970339 Mint B |
| Цена пула | 1 → 0.99906571985490616044 Mint B за 1 Mint A |
| Отказ | При минимуме 20 Mint B обмен отклонён с кодом 6018; токеновые балансы не изменились |

## Solana Explorer

- [Программа vault](https://explorer.solana.com/address/7Uk6iKLVg1JELBsXuqwHMzfu87QzzpUsGYW8VSaoYa8f?cluster=devnet)
- [Пул Raydium CLMM](https://explorer.solana.com/address/7z3nKcJrf1ReUBtrCMQRTKGDCQ7fYsZEnoVkhP7vC6AU?cluster=devnet)
- [Успешный обмен](https://explorer.solana.com/tx/FresDsHW9cdyh2CkVKTNJtynyK9HiJhgxv2TKaE2dwz6Cgo8Bx2BkfKK3QyBzmnZHWP9R3CkLWj1j6xUb113BFa?cluster=devnet)
- [Отказ из-за завышенного минимума](https://explorer.solana.com/tx/qi1m4SomWbXgkEYNqe61MBmAj94dxLXMdpCrnyQRZf5pptJNdzFHH9tYeonTnsPoDskw1njsoewp3JW9CABq59k?cluster=devnet)

## Скрипты

`01-init-vault.cjs` создаёт хранилища и привязывает пул, `02-deposit.cjs` вносит Mint A, `03-quote-swap.cjs` симулирует обмен, `04-execute-swap.cjs` проводит обмен, а `05-check-slippage.cjs` проверяет отказ. Скрипты используют IDL из `anchor build`, локальный кошелёк Solana CLI и переменную `SOLANA_RPC_URL` с адресом Helius Devnet из локального `.env`.
