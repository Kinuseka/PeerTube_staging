import { Injectable } from '@angular/core'
import { AuthService } from '@app/core/auth'
import { ServerService } from '@app/core/server'
import { environment } from '../../../environments/environment'
import { PluginService } from '@app/core/plugins/plugin.service'
import { ServerConfigTheme } from '@shared/models'
import { peertubeLocalStorage } from '@app/shared/misc/peertube-web-storage'
import { first } from 'rxjs/operators'

@Injectable()
export class ThemeService {

  private static KEYS = {
    LAST_ACTIVE_THEME: 'last_active_theme'
  }

  private oldThemeName: string
  private themes: ServerConfigTheme[] = []

  private themeFromLocalStorage: ServerConfigTheme
  private themeDOMLinksFromLocalStorage: HTMLLinkElement[] = []

  constructor (
    private auth: AuthService,
    private pluginService: PluginService,
    private server: ServerService
  ) {}

  initialize () {
    // Try to load from local storage first, so we don't have to wait network requests
    this.loadAndSetFromLocalStorage()

    this.server.configLoaded
        .subscribe(() => {
          const themes = this.server.getConfig().theme.registered

          this.removeThemeFromLocalStorageIfNeeded(themes)
          this.injectThemes(themes)

          this.listenUserTheme()
        })
  }

  private injectThemes (themes: ServerConfigTheme[], fromLocalStorage = false) {
    this.themes = themes

    console.log('Injecting %d themes.', this.themes.length)

    const head = this.getHeadElement()

    for (const theme of this.themes) {
      // Already added this theme?
      if (fromLocalStorage === false && this.themeFromLocalStorage && this.themeFromLocalStorage.name === theme.name) continue

      for (const css of theme.css) {
        const link = document.createElement('link')

        const href = environment.apiUrl + `/themes/${theme.name}/${theme.version}/css/${css}`
        link.setAttribute('href', href)
        link.setAttribute('rel', 'alternate stylesheet')
        link.setAttribute('type', 'text/css')
        link.setAttribute('title', theme.name)
        link.setAttribute('disabled', '')

        if (fromLocalStorage === true) this.themeDOMLinksFromLocalStorage.push(link)

        head.appendChild(link)
      }
    }
  }

  private getCurrentTheme () {
    if (this.themeFromLocalStorage) return this.themeFromLocalStorage.name

    if (this.auth.isLoggedIn()) {
      const theme = this.auth.getUser().theme
      if (theme !== 'instance-default') return theme
    }

    return this.server.getConfig().theme.default
  }

  private loadTheme (name: string) {
    const links = document.getElementsByTagName('link')
    for (let i = 0; i < links.length; i++) {
      const link = links[ i ]
      if (link.getAttribute('rel').indexOf('style') !== -1 && link.getAttribute('title')) {
        link.disabled = link.getAttribute('title') !== name
      }
    }
  }

  private updateCurrentTheme () {
    if (this.oldThemeName) this.removeThemePlugins(this.oldThemeName)

    const currentTheme = this.getCurrentTheme()

    console.log('Enabling %s theme.', currentTheme)

    this.loadTheme(currentTheme)

    const theme = this.getTheme(currentTheme)
    if (theme) {
      console.log('Adding scripts of theme %s.', currentTheme)
      this.pluginService.addPlugin(theme, true)

      this.pluginService.reloadLoadedScopes()

      peertubeLocalStorage.setItem(ThemeService.KEYS.LAST_ACTIVE_THEME, JSON.stringify(theme))
    } else {
      peertubeLocalStorage.removeItem(ThemeService.KEYS.LAST_ACTIVE_THEME)
    }

    this.oldThemeName = currentTheme
  }

  private listenUserTheme () {
    // We don't need them anymore
    this.themeFromLocalStorage = undefined
    this.themeDOMLinksFromLocalStorage = []

    if (!this.auth.isLoggedIn()) {
      this.updateCurrentTheme()
    }

    this.auth.userInformationLoaded
      .pipe(first())
      .subscribe(() => this.updateCurrentTheme())
  }

  private loadAndSetFromLocalStorage () {
    const lastActiveThemeString = peertubeLocalStorage.getItem(ThemeService.KEYS.LAST_ACTIVE_THEME)
    if (!lastActiveThemeString) return

    try {
      const lastActiveTheme = JSON.parse(lastActiveThemeString)
      this.themeFromLocalStorage = lastActiveTheme

      this.injectThemes([ lastActiveTheme ], true)
      this.updateCurrentTheme()
    } catch (err) {
      console.error('Cannot parse last active theme.', err)
      return
    }
  }

  private removeThemePlugins (themeName: string) {
    const oldTheme = this.getTheme(themeName)
    if (oldTheme) {
      console.log('Removing scripts of old theme %s.', themeName)
      this.pluginService.removePlugin(oldTheme)
    }
  }

  private removeThemeFromLocalStorageIfNeeded (themes: ServerConfigTheme[]) {
    if (!this.themeFromLocalStorage) return

    const loadedTheme = themes.find(t => t.name === this.themeFromLocalStorage.name)
    if (!loadedTheme || loadedTheme.version !== this.themeFromLocalStorage.version) {
      // Need to remove this theme: we loaded an old version or a theme that does not exist anymore
      this.removeThemePlugins(this.themeFromLocalStorage.name)
      this.oldThemeName = undefined

      const head = this.getHeadElement()
      for (const htmlLinkElement of this.themeDOMLinksFromLocalStorage) {
        head.removeChild(htmlLinkElement)
      }

      this.themeFromLocalStorage = undefined
      this.themeDOMLinksFromLocalStorage = []
    }
  }

  private getHeadElement () {
    return document.getElementsByTagName('head')[0]
  }

  private getTheme (name: string) {
    return this.themes.find(t => t.name === name)
  }
}
