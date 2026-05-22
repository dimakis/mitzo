#!/usr/bin/env ruby
# Add watchOS target to existing Xcode project and wire MitzoShared

require 'xcodeproj'

project_path = File.join(__dir__, 'App', 'App.xcodeproj')
project = Xcodeproj::Project.open(project_path)

# ─── 1. Add MitzoShared as a local Swift package ─────────────────────────────

mitzo_shared_ref = project.root_object.package_references.find { |p|
  p.is_a?(Xcodeproj::Project::Object::XCLocalSwiftPackageReference) && p.relative_path == '../MitzoShared'
}
unless mitzo_shared_ref
  mitzo_shared_ref = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
  mitzo_shared_ref.relative_path = '../MitzoShared'
  project.root_object.package_references << mitzo_shared_ref
end

# Add MitzoShared dependency to existing App target
app_target = project.targets.find { |t| t.name == 'App' }
unless app_target.package_product_dependencies.any? { |d| d.product_name == 'MitzoShared' }
  dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dep.product_name = 'MitzoShared'
  dep.package = mitzo_shared_ref
  app_target.package_product_dependencies << dep

  build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  build_file.product_ref = dep
  app_target.frameworks_build_phase.files << build_file
end

# ─── 2. Create MitzoWatch target ─────────────────────────────────────────────

watch_target = project.new_target(:watch2_app, 'MitzoWatch', :watchos, '10.0')

# Set build settings for both Debug and Release
watch_target.build_configurations.each do |config|
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.mitzo.app.watchkitapp'
  config.build_settings['DEVELOPMENT_TEAM'] = 'Y4QGXHYSY3'
  config.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
  config.build_settings['SWIFT_VERSION'] = '5.0'
  config.build_settings['WATCHOS_DEPLOYMENT_TARGET'] = '10.0'
  config.build_settings['SDKROOT'] = 'watchos'
  config.build_settings['TARGETED_DEVICE_FAMILY'] = '4'  # Watch
  config.build_settings['INFOPLIST_FILE'] = '$(SRCROOT)/../MitzoWatch/Info.plist'
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = '$(SRCROOT)/../MitzoWatch/MitzoWatch.entitlements'
  config.build_settings['ASSETCATALOG_COMPILER_APPICON_NAME'] = 'AppIcon'
  config.build_settings['MARKETING_VERSION'] = '1.0'
  config.build_settings['CURRENT_PROJECT_VERSION'] = '1'
  config.build_settings['GENERATE_INFOPLIST_FILE'] = 'NO'
  config.build_settings['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks']

  if config.name == 'Debug'
    config.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = 'DEBUG'
    config.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = '-Onone'
    config.build_settings['DEBUG_INFORMATION_FORMAT'] = 'dwarf'
  else
    config.build_settings['SWIFT_OPTIMIZATION_LEVEL'] = '-O'
    config.build_settings['SWIFT_COMPILATION_MODE'] = 'wholemodule'
    config.build_settings['DEBUG_INFORMATION_FORMAT'] = 'dwarf-with-dsym'
  end
end

# ─── 3. Add MitzoShared dependency to watch target ───────────────────────────

watch_dep = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
watch_dep.product_name = 'MitzoShared'
watch_dep.package = mitzo_shared_ref
watch_target.package_product_dependencies << watch_dep

watch_build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
watch_build_file.product_ref = watch_dep
watch_target.frameworks_build_phase.files << watch_build_file

# ─── 4. Add MitzoWatch source files ──────────────────────────────────────────

watch_dir = File.join(__dir__, 'MitzoWatch')

# Create group structure
watch_group = project.main_group.new_group('MitzoWatch', '../MitzoWatch')
services_group = watch_group.new_group('Services', 'Services')
views_group = watch_group.new_group('Views', 'Views')

# Add source files
swift_files = []

# Root files
Dir.glob(File.join(watch_dir, '*.swift')).each do |path|
  ref = watch_group.new_file(File.basename(path))
  swift_files << ref
end

# Services
Dir.glob(File.join(watch_dir, 'Services', '*.swift')).each do |path|
  ref = services_group.new_file(File.basename(path))
  swift_files << ref
end

# Views
Dir.glob(File.join(watch_dir, 'Views', '*.swift')).each do |path|
  ref = views_group.new_file(File.basename(path))
  swift_files << ref
end

# Add to Sources build phase
swift_files.each do |ref|
  watch_target.source_build_phase.add_file_reference(ref)
end

# Add Info.plist and entitlements as file references (not compiled)
watch_group.new_file('Info.plist')
watch_group.new_file('MitzoWatch.entitlements')

# ─── 5. Add watch target to project attributes ──────────────────────────────

attrs = project.root_object.attributes['TargetAttributes'] || {}
attrs[watch_target.uuid] = {
  'CreatedOnToolsVersion' => '16.0',
  'ProvisioningStyle' => 'Automatic',
}
project.root_object.attributes['TargetAttributes'] = attrs

# ─── 6. Add watch product to Products group ──────────────────────────────────

products_group = project.main_group.children.find { |g| g.name == 'Products' }
if products_group
  watch_product = watch_target.product_reference
  products_group.children << watch_product unless products_group.children.include?(watch_product)
end

# ─── 7. Save ─────────────────────────────────────────────────────────────────

project.save
puts "✅ watchOS target 'MitzoWatch' added to #{project_path}"
puts "   - MitzoShared linked to both App and MitzoWatch targets"
puts "   - #{swift_files.count} Swift files added to MitzoWatch Sources"
