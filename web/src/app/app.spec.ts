import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoTestingModule } from '@jsverse/transloco';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      // App injects LangService, which needs Transloco. The testing module supplies it with in-memory
      // (empty) dictionaries, so nothing is fetched from public/i18n/.
      imports: [
        App,
        TranslocoTestingModule.forRoot({
          langs: { pt: {}, en: {} },
          translocoConfig: { availableLangs: ['pt', 'en', 'es', 'de', 'fr', 'it', 'ru', 'nl', 'ja', 'zh'], defaultLang: 'pt' },
        }),
      ],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
