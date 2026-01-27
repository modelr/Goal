# Goal (одностраничник)

## Что это
- Долгосрочная цель “Ставка” (месяц/квартал) + кнопка “Готово”
- Цели на день + отметка “сделано сегодня”
- Сохранение “записи дня” (история)
- Streak-календарь: день закрашивается если есть **любая** запись в этот день
- TTL 48 часов: если приложение не открывали > 48ч — локальные данные очищаются

## Хранилище / синхронизация
- До логина: localStorage — источник правды
- После логина: Supabase — источник правды, localStorage — кэш/фолбэк
- При сбоях Supabase приложение продолжает работать локально (fault tolerance)

## Supabase (рекомендуемая схема)
Таблица `goal_states`:
- user_id uuid primary key references auth.users(id)
- state jsonb not null
- updated_at timestamptz not null default now()

RLS включить.
Policies:
- select: auth.uid() = user_id
- insert: auth.uid() = user_id
- update: auth.uid() = user_id
