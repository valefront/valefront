# Library use

```typescript
import { Router, QuotaManager, GeminiProvider, OpenAIProvider, LMStudioProvider } from '@valefront/valefront';

const quotaManager = new QuotaManager();
quotaManager.setQuota('Gemini', { requestsPerMinute: 10, requestsPerDay: 1000 });

const router = new Router({ quotaManager });
router.addProvider(new GeminiProvider(process.env.GEMINI_API_KEY));
router.addProvider(new OpenAIProvider(process.env.OPENAI_API_KEY));
router.addProvider(new LMStudioProvider('http://localhost:1234/v1'));

const response = await router.route({
  model: 'auto',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.choices[0].message.content);

for await (const chunk of router.routeStream({
  model: 'auto',
  messages: [{ role: 'user', content: 'Tell me a story.' }],
})) {
  process.stdout.write(chunk.choices[0].delta.content || '');
}
```

## Tiered routing

Pass a `Classifier` built on any function that calls a small model, and a tier map. `resolveRoute` returns the decision without making the call.

```typescript
import { Router, Classifier } from '@valefront/valefront';

const classify = async (system: string, userMessage: string): Promise<string> => {
  // Call your classifier model and return its text.
  return 'COMPLEXITY: complex\nDOMAIN: coding\nREASONING: true';
};

const router = new Router({
  classifier: new Classifier(classify),
  tierConfig: { '2b': 'small-model', '4b': 'medium-model', '12b': 'large-model' },
});

const route = await router.resolveRoute({ userMessage: 'build a todo app', chatHistory: [] });
console.log(route.selectedTier, route.selectedModel);
```
