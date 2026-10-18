'use strict';

/*
 * Classificador local de triagem por texto.
 * Técnica: Naive Bayes multinomial + regras de segurança para sinais de perigo imediato.
 * Objetivo acadêmico: protótipo de IA explicável e sem dependência de API externa.
 * IMPORTANTE: o resultado é apoio à priorização e nunca substitui avaliação humana.
 */

const CLASSES = ['Padrao', 'Atencao', 'Alta', 'Urgente'];

const TRAINING = [
  ['Padrao', 'quero orientação sobre meus direitos e saber onde buscar ajuda'],
  ['Padrao', 'preciso registrar um caso antigo para ter orientação'],
  ['Padrao', 'quero entender como denunciar e quais documentos preciso'],
  ['Padrao', 'houve discussão e quero orientação sobre os próximos passos'],
  ['Padrao', 'quero apoio para entender uma situação que aconteceu antes'],

  ['Atencao', 'ele me humilha constantemente e controla com quem eu falo'],
  ['Atencao', 'sou xingada e diminuída todos os dias'],
  ['Atencao', 'ele controla meu dinheiro e impede que eu use meus bens'],
  ['Atencao', 'quebrou meus objetos e rasgou documentos pessoais'],
  ['Atencao', 'faz ameaças indiretas e me persegue nas redes sociais'],
  ['Atencao', 'espalha mentiras sobre mim e me constrange em público'],

  ['Alta', 'ele me empurrou e me agrediu com tapas e socos'],
  ['Alta', 'as agressões físicas estão acontecendo com frequência'],
  ['Alta', 'ele me persegue e aparece repetidamente nos lugares onde estou'],
  ['Alta', 'fui forçada a manter relação sexual contra minha vontade'],
  ['Alta', 'ele ameaça me machucar e já destruiu coisas dentro de casa'],
  ['Alta', 'tenho medo porque ele me segue e faz ameaças diretas'],

  ['Urgente', 'ele está aqui na porta agora e disse que vai me matar'],
  ['Urgente', 'estou em perigo agora e ele está armado'],
  ['Urgente', 'ele tentou me estrangular e eu acho que pode voltar'],
  ['Urgente', 'ameaçou me matar com uma faca e está vindo para cá'],
  ['Urgente', 'há uma arma e risco imediato de morte'],
  ['Urgente', 'estou presa e não consigo sair com segurança'],
  ['Urgente', 'ele está me atacando neste momento preciso de ajuda agora']
];

const STOPWORDS = new Set([
  'a','ao','aos','as','o','os','e','de','da','das','do','dos','em','no','na','nos','nas',
  'um','uma','uns','umas','que','eu','me','meu','minha','meus','minhas','ele','ela','eles','elas',
  'para','por','com','sem','se','ja','muito','mais','como','sobre','isso','essa','esse','esta','este',
  'foi','ser','estar','estou','estava','tem','tenho','teve','ter','porque','quando','onde','aqui'
]);

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function trainModel() {
  const docsPerClass = Object.fromEntries(CLASSES.map(c => [c, 0]));
  const tokenCounts = Object.fromEntries(CLASSES.map(c => [c, new Map()]));
  const totalTokens = Object.fromEntries(CLASSES.map(c => [c, 0]));
  const vocab = new Set();

  for (const [label, text] of TRAINING) {
    docsPerClass[label]++;
    for (const token of tokenize(text)) {
      vocab.add(token);
      const map = tokenCounts[label];
      map.set(token, (map.get(token) || 0) + 1);
      totalTokens[label]++;
    }
  }

  return { docsPerClass, tokenCounts, totalTokens, vocabSize: vocab.size, totalDocs: TRAINING.length };
}

const MODEL = trainModel();

const URGENT_PATTERNS = [
  /agora/, /neste momento/, /esta vindo/, /esta aqui/, /na porta/,
  /arma/, /revolver/, /pistola/, /faca/, /facao/,
  /matar/, /morte/, /estrangular/, /sufocar/, /presa/, /cativeiro/
];

const HIGH_PATTERNS = [
  /soco/, /tapa/, /agredi/, /agressao/, /forcad[ao]/, /relacao sexual.*contra/,
  /persegue/, /perseguicao/, /ameaca/, /ameacou/
];

function softmax(logScores) {
  const max = Math.max(...Object.values(logScores));
  const exps = {};
  let sum = 0;
  for (const [k, v] of Object.entries(logScores)) {
    exps[k] = Math.exp(v - max);
    sum += exps[k];
  }
  const probs = {};
  for (const [k, v] of Object.entries(exps)) probs[k] = v / sum;
  return probs;
}

function classifyWithNaiveBayes(text) {
  const tokens = tokenize(text);
  const scores = {};

  for (const label of CLASSES) {
    const prior = MODEL.docsPerClass[label] / MODEL.totalDocs;
    let logp = Math.log(prior);
    const denom = MODEL.totalTokens[label] + MODEL.vocabSize;

    for (const token of tokens) {
      const count = MODEL.tokenCounts[label].get(token) || 0;
      logp += Math.log((count + 1) / denom);
    }
    scores[label] = logp;
  }

  const probs = softmax(scores);
  const ordered = Object.entries(probs).sort((a, b) => b[1] - a[1]);
  return { label: ordered[0][0], confidence: ordered[0][1], probabilities: probs, tokens };
}

function analyzeImmediateRisk(text) {
  const n = normalize(text);
  const urgentMatches = URGENT_PATTERNS.filter(re => re.test(n)).map(re => re.source);
  const highMatches = HIGH_PATTERNS.filter(re => re.test(n)).map(re => re.source);
  return { urgentMatches, highMatches };
}

function classifyTriage({ descricao, tipoViolencia = '' }) {
  const combined = `${descricao || ''} ${String(tipoViolencia).replace(/_/g, ' ')}`;
  const base = classifyWithNaiveBayes(combined);
  const risk = analyzeImmediateRisk(combined);

  let nivel = base.label;
  let motivo = 'Classificação probabilística baseada no texto informado.';

  // Camada de segurança: sinais explícitos de perigo imediato têm prioridade.
  if (risk.urgentMatches.length >= 2 || (risk.urgentMatches.length >= 1 && /agora|neste momento|esta vindo|esta aqui/.test(normalize(combined)))) {
    nivel = 'Urgente';
    motivo = 'Foram detectados sinais textuais de possível perigo imediato.';
  } else if (nivel === 'Padrao' && risk.highMatches.length >= 1) {
    nivel = 'Alta';
    motivo = 'Foram detectados sinais textuais compatíveis com violência ou ameaça direta.';
  }

  const confidence = Math.max(base.confidence, nivel === 'Urgente' && risk.urgentMatches.length ? 0.88 : 0);

  return {
    nivel,
    confianca: Number(Math.min(confidence, 0.99).toFixed(3)),
    modelo: 'NaiveBayes-v1+hibrido-seguranca',
    motivo,
    aviso: 'Triagem experimental para apoio à priorização; exige revisão humana.'
  };
}

module.exports = { classifyTriage, tokenize };
