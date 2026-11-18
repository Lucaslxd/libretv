require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'LtbridgeProxy'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'MIT' }
  s.homepage = 'https://github.com/libretv'
  s.author = 'LibreTV'
  s.source = { :git => 'https://github.com/libretv/ltbridge-proxy.git', :tag => s.version.to_s }

  s.ios.deployment_target = '14.0'
  s.swift_version = '5.1'
  s.source_files = 'ios/Sources/**/*.swift'
  s.frameworks = 'Foundation'

  s.dependency 'Capacitor'
  s.dependency 'GCDWebServer', '~> 3.5'
end
