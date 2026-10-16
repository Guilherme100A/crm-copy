# Conteúdo reutilizável (T35)

Respostas rápidas, modelos internos de mensagem, variáveis globais e figurinhas (`packages/core/src/content`,
`apps/api/src/routes/content`).

## Decisão: figurinhas só em `image/webp`, sem conversão

- `POST /api/stickers` aceita **apenas `image/webp`** de até **100 KB** (o limite da referência, 17 §3A).
  Outro tipo → `415 UNSUPPORTED_MEDIA` (`error_code: sticker_not_webp`); acima do limite → `413 PAYLOAD_TOO_LARGE`.
- **Não convertemos** PNG/JPEG para WebP com `sharp`. Motivos:
  - `sharp` é binário nativo e hoje só está previsto na imagem do worker (STACK §0.1). Colocá-lo na API exigiria o
    binário também nesse processo.
  - O WhatsApp exige figurinha WebP 512×512 (estática ou animada). Uma conversão automática teria de redimensionar
    e recortar, e o resultado poderia sair diferente do que o usuário espera. É mais previsível o cliente gerar o WebP
    (a tela "Criar Sticker" da referência faz isso no navegador).
- Se for preciso aceitar outros formatos, o caminho é um job no worker (que já tem `sharp`) gerando o WebP a partir
  da mídia original, sem mudar o contrato desta rota.

## Modelos internos (no lugar dos templates WABA)

Sem status/aprovação da Meta. Os botões viram texto (mensagens interativas ficam fora no Baileys, SPEC 8.3):
`reply` → menu numerado (`1 - Opção`); `url`/`phone` → `Texto: destino`. O cabeçalho de mídia vai como mídia à parte.

## Variáveis globais

Nome `g_` + `[A-Za-z0-9_]`, imutável depois de criado (os fluxos referenciam `{g_nome}`); tipo `text|number`
(o número é validado com `^-?\d+(\.\d+)?$`).
