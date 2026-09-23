# Target Stock's

Painel pessoal para acompanhar ativos da B3, com rankings de liquidez, filtros, páginas de detalhes e histórico de preços.

## Estado atual

O frontend consulta dados públicos da [brapi](https://brapi.dev/) e atualiza a visão de mercado a cada 15 segundos. A frequência de atualização do painel não significa que a fonte seja tempo real: as cotações podem ter atraso.

O repositório também contém um bridge experimental para MetaTrader 5. Ele abre um WebSocket local em `ws://localhost:8765`, mas a ativação desse feed na interface ainda não está concluída.

## Funcionalidades

- listagem de ações, Units, FIIs, ETFs e BDRs;
- busca por ticker ou empresa e filtro por setor;
- rankings por volume financeiro estimado, quantidade e variação;
- detalhes do ativo com histórico de 1, 3 e 5 anos;
- atualização automática e atualização manual;
- fallback de histórico via Yahoo Finance durante o desenvolvimento;
- bridge local opcional para dados do MetaTrader 5.

## Requisitos

- Node.js 22.12 ou superior;
- npm;
- Windows com MetaTrader 5, apenas para o bridge opcional.

## Executar o frontend

```bash
npm install
npm run dev
```

Abra o endereço exibido pelo Vite, normalmente `http://localhost:5173`.

## Verificações

```bash
npm run typecheck
npm run build
npm run preview
```

## Bridge do MetaTrader 5

No Windows, com o MetaTrader 5 instalado e conectado a uma corretora que disponibilize ativos da B3:

```bash
py -m venv .venv
.venv\Scripts\activate
py -m pip install -r requirements.txt
py mt5_bridge.py
```

O bridge consulta os ativos configurados em `DEFAULT_SYMBOLS` e publica snapshots locais. Nunca inclua login, senha ou token da corretora no código.

## Estrutura

```text
.
├── src/
│   ├── main.tsx
│   ├── style.css
│   └── vite-env.d.ts
├── index.html
├── mt5_bridge.py
├── package.json
├── requirements.txt
├── tsconfig.json
└── vite.config.ts
```

## Próximos passos

- conectar o feed do MT5 à interface e permitir alternar a fonte de dados;
- separar `main.tsx` em componentes e serviços menores;
- adicionar notícias, documentos de RI/CVM e análise assistida por IA;
- incluir testes automatizados e configuração de publicação;
- tratar o calendário oficial e os feriados da B3.

## Aviso

Este projeto tem finalidade informativa e educacional. Os dados podem apresentar atraso ou inconsistências e não constituem recomendação de investimento.
